import type { Ref } from "react";
import { SLIDES } from "./slides";

const CHART_LINE = "M0 540 L80 520 L160 530 L240 470 L320 490 L400 420 L480 440 L560 360 L640 390 L720 320 L800 340 L880 260 L960 290 L1040 210 L1120 230 L1200 150 L1280 170 L1360 100 L1440 80";
const GRID_LINES = [160, 320, 480];
const GRID_COLUMNS = [360, 720, 1080];

function Slide({ index }: { index: number }) {
  const slide = SLIDES[index]!;
  const Heading = index === 0 ? "h1" : "h2";
  const [first, last] = slide.lines;
  return (
    <div className="landing-slide" data-slide={index + 1}>
      <p className="text-m font-bold tracking-[0.1em] text-accent">{String(index + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}</p>
      <Heading className="landing-heading">
        {first}
        <br />
        {slide.accentLast ? <span className="text-accent">{last}</span> : last}
      </Heading>
      <p className="landing-lead">{slide.body}</p>
    </div>
  );
}

export function ScrollStory({ reduced, storyRef }: { reduced: boolean; storyRef: Ref<HTMLElement> }) {
  return (
    <div className="landing-pin" data-reduced={reduced || undefined}>
      <section ref={storyRef} aria-label="스크롤 이야기" className="landing-story" data-step={reduced ? undefined : 1}>
        {!reduced && <div aria-hidden="true" className="landing-progress" />}
        <svg aria-hidden="true" viewBox="0 0 1440 640" preserveAspectRatio="none" className="landing-chart">
          <g stroke="var(--grid)">
            {GRID_LINES.map((y) => <line key={y} x1="0" y1={y} x2="1440" y2={y} />)}
            {GRID_COLUMNS.map((x) => <line key={x} x1={x} y1="0" x2={x} y2="640" />)}
          </g>
          <path className="landing-line" pathLength="1000" d={CHART_LINE} fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="landing-slides">
          {SLIDES.map((_, index) => <Slide key={index} index={index} />)}
        </div>
        {!reduced && (
          <p aria-hidden="true" className="landing-hint">
            스크롤
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v11M3.5 8.5L8 13l4.5-4.5" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </p>
        )}
      </section>
    </div>
  );
}
