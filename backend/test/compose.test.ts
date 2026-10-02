import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { jobsGaplessConfig, loadJobsEnv, loadKeeperEnv, loadRelayEnv, missingKeeperRuntime } from '../src/lib/env.ts';
import { SECRET_ENV_KEYS } from '../src/lib/log.ts';

type Service = {
  environment: Record<string, string>;
  ports?: string[];
  networks: Record<string, { aliases?: string[] } | null> | string[];
  volumes: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string;
  cpus?: string;
  tmpfs?: string[];
  healthcheck?: { test: string[] };
  stop_grace_period?: string;
};
type Compose = {
  services: Record<'relay' | 'keeper' | 'jobs', Service>;
  networks: Record<string, { ipam?: { config: { subnet: string; gateway: string }[] } }>;
  volumes: Record<string, { name: string }>;
};

const compose = Bun.YAML.parse(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')) as Compose;
const { relay, keeper, jobs } = compose.services;

// ENV defaults baked into the image; compose environment overrides them.
function imageEnv(): Record<string, string> {
  const text = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const block = text.match(/^ENV\s+((?:.*\\\n)*.*)$/m)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/([A-Z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
}

// Generated per run, never written anywhere.
const fixtures: Record<string, string> = {
  KEEPER_KEY: generatePrivateKey(),
  RELAY_INTERNAL_TOKEN: randomBytes(32).toString('hex'),
  ENVIO_API_TOKEN: 'tok',
  MONAD_HTTP_URLS: 'https://a.example/k',
  MONAD_WS_URL: 'wss://a.example/k',
  APP_ORIGIN: 'https://app.gapless.test'
};

const INTERPOLATION = /^\$\{([A-Z_]+)(?::\?[^}]*|:-)\}$/;

function resolve(svc: Service): Record<string, string> {
  const out: Record<string, string> = { ...imageEnv() };
  for (const [k, v] of Object.entries(svc.environment)) {
    const m = String(v).match(INTERPOLATION);
    out[k] = m ? (fixtures[m[1]!] ?? '') : String(v);
  }
  return out;
}

const secretNames = (svc: Service) => Object.keys(svc.environment).filter((k) => (SECRET_ENV_KEYS as readonly string[]).includes(k)).sort();

describe('docker-compose.yml secrets', () => {
  test('every secret is interpolated from .env.docker, never a literal', () => {
    for (const svc of [relay, keeper, jobs]) {
      for (const k of secretNames(svc)) expect(svc.environment[k]).toMatch(new RegExp(`^\\$\\{${k}(:\\?|:-)`));
    }
  });

  test('each process gets only the secrets it uses', () => {
    expect(secretNames(jobs)).toEqual(['ENVIO_API_TOKEN', 'MONAD_HTTP_URLS']);
    expect(secretNames(relay)).toEqual(['MONAD_HTTP_URLS', 'MONAD_WS_URL', 'RELAY_INTERNAL_TOKEN', 'RELAY_KEY']);
    expect(secretNames(keeper)).toEqual(['KEEPER_KEY', 'MONAD_HTTP_URLS', 'MONAD_WS_URL', 'RELAY_INTERNAL_TOKEN']);
  });

  test('no other value interpolates (non-secret config lives in the file)', () => {
    const allowed = new Set([...SECRET_ENV_KEYS, 'APP_ORIGIN']);
    for (const svc of [relay, keeper, jobs]) {
      for (const [k, v] of Object.entries(svc.environment)) if (String(v).includes('$')) expect(allowed.has(k)).toBe(true);
    }
  });
});

describe('docker-compose.yml env parses through the schemas', () => {
  test('relay', () => {
    const env = loadRelayEnv(resolve(relay));
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.RELAY_KEY).toBeUndefined();
    expect(env.SPONSOR_ENABLED).toBe(false);
    expect(env.KEEPER_INTERNAL_URL).toBeDefined();
  });

  test('keeper has every runtime var', () => {
    expect(missingKeeperRuntime(loadKeeperEnv(resolve(keeper)))).toEqual([]);
  });

  test('jobs has Gapless stats configured', () => {
    expect(jobsGaplessConfig(loadJobsEnv(resolve(jobs)))).not.toBeNull();
  });

  test('relay and jobs name the same files on the shared volume', () => {
    const r = loadRelayEnv(resolve(relay));
    const j = loadJobsEnv(resolve(jobs));
    expect(r.GAP_INDEX_DIR).toBe(j.OUT_DIR);
    expect(r.JOBS_DB_PATH).toBe(j.JOBS_DB_PATH);
    expect(relay.volumes[0]!.split(':')[0]).toBe(jobs.volumes[0]!.split(':')[0]!);
    expect(keeper.volumes[0]!.split(':')[0]).not.toBe(relay.volumes[0]!.split(':')[0]!);
  });
});

const DEPLOYMENT_PATH = new URL('../../deployments/143.json', import.meta.url);
const deployment = existsSync(DEPLOYMENT_PATH) ? JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')) : null;

describe.skipIf(!deployment)('docker-compose.yml matches deployments/143.json', () => {
  test('addresses, start block and listed perp', () => {
    const c = deployment.contracts;
    expect(keeper.environment.COVER_MANAGER_ADDRESS).toBe(c.CoverManager.address);
    expect(keeper.environment.LISTED_PERPS).toBe(String(deployment.listing.perpId));
    expect(relay.environment.GAPLESS_FACTORY_ADDRESS).toBe(c.GaplessFactory.address);
    expect(jobs.environment.COVER_MANAGER_ADDRESS).toBe(c.CoverManager.address);
    expect(jobs.environment.COVER_VAULT_ADDRESS).toBe(c.CoverVault.address);
    expect(jobs.environment.GAPLESS_FACTORY_ADDRESS).toBe(c.GaplessFactory.address);
    expect(jobs.environment.GAPLESS_CRE_SINK_ADDRESS).toBe(c.GaplessCreSink.address);
    expect(jobs.environment.GAPLESS_START_BLOCK).toBe(String(deployment.deployBlock));
  });
});

describe('docker-compose.yml network and hardening', () => {
  const nets = (svc: Service) => (Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks));
  const aliases = (svc: Service, net: string) => (Array.isArray(svc.networks) ? [] : (svc.networks[net]?.aliases ?? []));

  test('internal URLs point at aliases on the shared private network', () => {
    expect(nets(relay)).toEqual(['gapless']);
    expect(nets(keeper)).toEqual(['gapless']);
    expect(nets(jobs)).not.toContain('gapless');
    expect(aliases(keeper, 'gapless')).toContain(new URL(relay.environment.KEEPER_INTERNAL_URL!).hostname);
    expect(aliases(relay, 'gapless')).toContain(new URL(keeper.environment.RELAY_WS_URL!).hostname);
  });

  test('TRUST_PROXY is exactly the pinned gateway the host proxy arrives from', () => {
    expect(relay.environment.TRUST_PROXY).toBe(compose.networks.gapless!.ipam!.config[0]!.gateway);
  });

  test('only the relay publishes, on loopback only', () => {
    for (const p of relay.ports ?? []) expect(p).toStartWith('127.0.0.1:');
    expect(relay.ports).toHaveLength(2);
    expect(keeper.ports).toBeUndefined();
    expect(jobs.ports).toBeUndefined();
  });

  test('CLAUDE.md runtime hardening on every service', () => {
    for (const svc of [relay, keeper, jobs]) {
      expect(svc.read_only).toBe(true);
      expect(svc.cap_drop).toEqual(['ALL']);
      expect(svc.security_opt).toContain('no-new-privileges=true');
      expect(svc.pids_limit).toBeGreaterThan(0);
      expect(svc.mem_limit).toBeDefined();
      expect(svc.cpus).toBeDefined();
      expect(svc.tmpfs?.[0]).toStartWith('/tmp:');
      expect(svc.volumes.map((v) => v.split(':')[1])).toEqual(['/app/data']);
      expect(svc.healthcheck?.test.slice(0, 2)).toEqual(['CMD', 'bun']);
    }
    expect(jobs.stop_grace_period).toBe('35s');
  });

  test('volume names are pinned so a renamed project never starts on empty ledgers', () => {
    for (const [key, v] of Object.entries(compose.volumes)) expect(v.name).toBe(key);
  });
});
