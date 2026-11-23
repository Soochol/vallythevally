import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { requestDefaultOpen } from "../../persist/defaultOpen";
import { BrandIcon } from "../icons";
import "./shellStates.css";

export const SHELL_ERROR_TITLE = "화면을 그리다 문제가 생겼습니다";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = { idle: "오류 내용 복사", copied: "복사했습니다", failed: "복사하지 못했습니다" };

export const errorReport = (error: Error): string => [`${error.name}: ${error.message}`, error.stack].filter(Boolean).join("\n");

export function ShellErrorScreen({ error }: { error: Error }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const report = errorReport(error);
  const copyReport = () => navigator.clipboard.writeText(report).then(() => setCopy("copied"), () => setCopy("failed"));
  const openDefault = () => {
    requestDefaultOpen();
    location.reload();
  };
  return (
    <main role="alert" aria-labelledby="shell-error-title" className="shell-error">
      <div className="shell-error-card">
        <span className="shell-error-brand"><BrandIcon />vally</span>
        <h1 id="shell-error-title">{SHELL_ERROR_TITLE}</h1>
        <p>저장된 레이아웃과 관심종목은 지워지지 않았습니다. 다시 불러와도 같은 문제가 나면 기본 화면으로 열어 보세요. 기본 화면에서 바꾼 것은 저장하지 않습니다.</p>
        <div className="shell-error-actions">
          <button type="button" className="btn-primary btn-lg" onClick={() => location.reload()}>다시 불러오기</button>
          <button type="button" className="btn btn-lg" onClick={openDefault}>기본 화면으로 열기</button>
          <button type="button" className="btn-ghost btn-lg" onClick={() => void copyReport()}>{COPY_LABEL[copy]}</button>
        </div>
        <details className="shell-error-detail"><summary>자세히</summary><pre>{report}</pre></details>
      </div>
    </main>
  );
}

export class ShellErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(SHELL_ERROR_TITLE, error, info.componentStack);
  }

  render() {
    return this.state.error ? <ShellErrorScreen error={this.state.error} /> : this.props.children;
  }
}
