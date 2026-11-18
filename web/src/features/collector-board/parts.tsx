import type { ReactNode } from "react";
import type { Tone } from "./labels";

const TEXT: Record<Tone, string> = { ok: "text-success", warn: "text-warning", bad: "text-danger", idle: "text-text-2" };
const DOT: Record<Tone, string | undefined> = { ok: "mint", warn: "amber", bad: "red", idle: undefined };

export const toneText = (tone: Tone): string => TEXT[tone];

export function ToneDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className="conn-dot" data-tone={DOT[tone]} />;
}

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 ${TEXT[tone]}`}><ToneDot tone={tone} />{children}</span>;
}

export function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={id} className="text-m font-semibold">{title}</h3>
        {note && <span className="text-s text-text-2">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-m text-text-2">{children}</p>;
}

export function Table({ label, head, children }: { label: string; head: readonly string[]; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[34rem] border-collapse text-m">
        <thead>
          <tr className="text-left text-s text-text-2">
            {head.map((h, i) => <th key={h} scope="col" className={`whitespace-nowrap border-b border-line px-2 py-1.5 font-normal ${i === 0 ? "" : "text-right first:text-left"}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Cell = ({ children, first = false }: { children: ReactNode; first?: boolean }) => (
  <td className={`border-b border-line px-2 py-1.5 ${first ? "text-left" : "text-right"}`}>{children}</td>
);
