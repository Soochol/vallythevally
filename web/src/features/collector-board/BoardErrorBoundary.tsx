import { Component, type ReactNode } from "react";

interface State {
  failed: boolean;
}

export class BoardErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="ui-state">
        <p>수집 현황판을 그리지 못했습니다</p>
        <button type="button" className="tb-btn" onClick={this.retry}>다시 시도</button>
      </div>
    );
  }
}
