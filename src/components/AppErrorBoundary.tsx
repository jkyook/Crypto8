import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("App rendering failed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="container">
          <section className="card" role="alert" style={{ padding: 24 }}>
            <h1>화면을 불러오지 못했습니다</h1>
            <p>앱 렌더링 중 예외가 발생했습니다. 새로고침 후에도 같으면 최근 변경된 화면 구성 요소를 다시 확인해야 합니다.</p>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{this.state.error.message}</pre>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
