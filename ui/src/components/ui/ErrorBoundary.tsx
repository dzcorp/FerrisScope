import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  /// Rendered in place of `children` after a render/lifecycle throw. Receives
  /// the caught error and a `reset` that clears the boundary so `children`
  /// re-mount (useful once the underlying cause is gone — e.g. after the
  /// operator navigates elsewhere). Remounting the boundary with a fresh `key`
  /// also resets it, which is how callers recover on navigation.
  fallback: (error: Error, reset: () => void) => ReactNode;
  /// Side-channel for logging/telemetry. MUST NOT throw.
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/// Generic React error boundary. Catches a throw from anywhere in its subtree's
/// render / lifecycle and shows `fallback` instead of letting the exception
/// unwind to the React root — which unmounts the whole tree and leaves a blank
/// white window. There was previously no boundary anywhere in the app, so a
/// single bad detail summary (e.g. a hooks-order violation) whited out the
/// entire UI. Wrap crash-prone, self-contained surfaces (detail panel body,
/// tab content) so a fault is contained to that surface.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never let logging throw and re-crash the boundary.
    try {
      this.props.onError?.(error, info);
    } catch {
      /* swallow */
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}
