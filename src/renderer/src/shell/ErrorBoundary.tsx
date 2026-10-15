// Contains crashes inside one screen or overlay so the shell (toolbar, music, background)
// keeps running. Shows a friendly card with the error and a retry button.
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../ui/Button'

interface Props {
  /** What crashed, for the message ("Browse", "Library"). */
  label: string
  children: ReactNode
  /** Compact layout for overlay panels. */
  compact?: boolean
  /** Render nothing instead of the card (app chrome: toolbar, toasts, background). */
  silent?: boolean
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] crashed`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.silent) return null
    return (
      <div className="g-crash" data-compact={this.props.compact || undefined}>
        <div className="g-crash__card">
          <TriangleAlert className="g-crash__icon" />
          <div className="g-crash__title">{this.props.label} hit a snag</div>
          <pre className="g-crash__msg g-selectable">{error.message || String(error)}</pre>
          <Button variant="soft" icon={<RotateCcw />} onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
