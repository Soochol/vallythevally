import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../lib/media";
import { useAccountStore } from "../../stores/account";
import { LandingBar } from "./LandingBar";
import { ScrollStory } from "./ScrollStory";
import { SERVER_NOTES } from "./slides";
import { useScrollStory } from "./useScrollStory";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function Landing() {
  const [failure] = useState(() => useAccountStore.getState().loginFailure);
  useEffect(() => useAccountStore.getState().showLoginFailure(null), []);
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const container = useRef<HTMLDivElement>(null);
  const story = useRef<HTMLElement>(null);
  useScrollStory(container, story, !reduced);

  return (
    <div ref={container} data-testid="landing" className="landing">
      <LandingBar initialFailure={failure} />
      <main>
        <ScrollStory reduced={reduced} storyRef={story} />
        <section aria-label="키와 개인정보" className="landing-note-wrap">
          <div className="landing-note">
            <h2 className="landing-note-title">서버에 가는 것은<br />셋업뿐입니다.</h2>
            <dl className="landing-note-list">
              {SERVER_NOTES.map((note) => (
                <div key={note.title}>
                  <dt className="text-l font-bold">{note.title}</dt>
                  <dd className="mt-1.5">{note.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <span className="text-m font-bold text-text-2">vally</span>
        <span>시세는 사용자 PC의 키움 REST API 연결에서만 가져옵니다.</span>
      </footer>
    </div>
  );
}
