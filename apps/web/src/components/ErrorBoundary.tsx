import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Error boundary.
 *
 * Without one, a single render error blanks the whole app and the message goes
 * only to the console, which, for a tool people use to edit their own data, means
 * "it broke and I have no idea why". Showing the message and keeping the rest of
 * the app alive is the difference between a bug report and a mystery.
 */

interface Props {
  children: ReactNode;
  /** Shown above the message, e.g. "the diagram canvas". */
  label: string;
  onRetry?: () => void;
}

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack in the console for diagnosis; the user gets the
    // readable message below.
    console.error(`error in ${this.props.label}:`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({});
    this.props.onRetry?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="boundary">
        <h2 className="boundary__title">Something went wrong in {this.props.label}</h2>
        <pre className="boundary__message">{error.message}</pre>
        {error.stack ? (
          <details className="boundary__details">
            <summary>Stack trace</summary>
            <pre className="boundary__stack">{error.stack}</pre>
          </details>
        ) : null}
        <button type="button" className="btn btn--sm" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}
