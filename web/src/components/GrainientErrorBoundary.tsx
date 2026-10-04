import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  fallback: ReactNode
  children: ReactNode
}

interface State {
  failed: boolean
}

/** Catches a WebGL-unavailable throw from Grainient and shows the static fallback (DESIGN 7.4). */
export class GrainientErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
