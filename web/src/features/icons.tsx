import type { ReactNode, SVGProps } from "react";

// 아이콘은 1.5px 선으로 직접 그렸다(frontend.md §1.1, 목업 index.html의 <symbol>).
function Icon({ children, size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const BrandIcon = ({ size = 22 }: P) => (
  <Icon size={size}>
    <path d="M2.5 6.5 8 17l4-6.5 4 6.5 5.5-10.5" strokeWidth={2.2} />
    <circle cx="12" cy="20.5" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);
export const SearchIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </Icon>
);
export const CandleIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M8 3v3M8 16v4M16 6v3M16 18v3" />
    <rect x="5.5" y="6" width="5" height="10" rx="0.5" />
    <rect x="13.5" y="9" width="5" height="9" rx="0.5" />
  </Icon>
);
export const ChevronIcon = ({ size = 12 }: P) => (
  <Icon size={size}>
    <path d="m7 10 5 5 5-5" />
  </Icon>
);
export const SunIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Icon>
);
export const MoonIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />
  </Icon>
);
export const ChartIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M4 4v16h16" />
    <path d="M8 15l3-4 3 2 5-6" />
  </Icon>
);
export const CheckIcon = ({ size = 14 }: P) => (
  <Icon size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const PlusIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ChevronRightIcon = ({ size = 16, flip = false }: P & { flip?: boolean }) => (
  <Icon size={size}>
    <path d={flip ? "m14.5 6-6 6 6 6" : "m9.5 6 6 6-6 6"} />
  </Icon>
);
export const CloseIcon = ({ size = 14 }: P) => (
  <Icon size={size}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);
export const ArrowIcon = ({ size = 16, dir }: P & { dir: "up" | "down" }) => (
  <Icon size={size}>
    <path d={dir === "up" ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
  </Icon>
);
export const ListIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" />
  </Icon>
);
export const CameraIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
    <circle cx="12" cy="13" r="3.5" />
  </Icon>
);
export const CopyIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Icon>
);
export const MoreIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);
export const IndicatorIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 17c3-1 4-9 7-9s3 6 6 6 3-4 5-5" />
    <path d="M3 21h18" />
  </Icon>
);
export const GearIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Icon>
);
export const EyeIcon = ({ size = 16, off = false }: P & { off?: boolean }) => (
  <Icon size={size}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.6" />
    {off && <path d="m4 4 16 16" />}
  </Icon>
);
export const FunnelIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
  </Icon>
);
export const DrawingsIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M6.5 17.5 17.5 6.5" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="5" r="2" />
  </Icon>
);
export const PenIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" />
    <path d="M13.5 7l3.5 3.5" />
  </Icon>
);
export const PlayIcon = ({ size = 10 }: P) => (
  <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" className="flex-none">
    <path d="M3 1.8v8.4L10 6z" fill="currentColor" />
  </svg>
);
export const SpinnerIcon = ({ size = 12 }: P) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="flex-none animate-spin motion-reduce:animate-none">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);
