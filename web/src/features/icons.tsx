import type { ReactNode, SVGProps } from "react";

export function Icon({ children, path, size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children?: ReactNode; path?: string }) {
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
      {path && <path d={path} />}
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
    <path d={ICON_PATHS.close} />
  </Icon>
);
export const ArrowIcon = ({ size = 16, dir }: P & { dir: "up" | "down" }) => (
  <Icon size={size}>
    <path d={ICON_PATHS[dir]} />
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
    <path d={ICON_PATHS.gear} />
  </Icon>
);
export const EyeIcon = ({ size = 16, off = false }: P & { off?: boolean }) => (
  <Icon size={size}>
    <path d={ICON_PATHS.eye} />
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

export const DRAWING_ICONS = {
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  empty: "M4 20 L20 4 M4 4 H9 M4 4 V9 M20 20 H15 M20 20 V15",
  locked: "M7 10 V7 A5 5 0 0 1 17 7 V10 M5 10 H19 V21 H5 Z",
  unlocked: "M7 10 V7 A5 5 0 0 1 17 7 M5 10 H19 V21 H5 Z",
  pointer: "M5 3 L5 20 L10 15 L14 22 L17 20 L13 13 L21 13 Z",
  magnet: "M5 4 V13 A7 7 0 0 0 19 13 V4 H14 V13 A2 2 0 0 1 10 13 V4 Z M5 8 H10 M14 8 H19",
  keepDrawing: "M4 16 L15 5 L19 9 L8 20 L3 21 Z M14 6 L18 10 M15 17 A4 4 0 1 0 20 13 M20 13 V17 H16",
  lockAll: "M7 10 V7 A5 5 0 0 1 17 7 V10 M5 10 H19 V21 H5 Z M12 14 V17",
  eye: "M2 12 Q12 -2 22 12 Q12 26 2 12 M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12",
  trash: "M4 6 H20 M9 6 V3 H15 V6 M6 6 L7 21 H17 L18 6 M10 10 V17 M14 10 V17",
  objects: "M9 5 H21 M9 12 H21 M9 19 H21 M3 4 H5 V6 H3 Z M3 11 H5 V13 H3 Z M3 18 H5 V20 H3 Z",
  settings: "M9 3 H15 L16 6 L19 7 L21 10 L19 12 L20 16 L17 19 L14 18 L12 21 L9 19 L5 19 L3 15 L5 12 L3 9 L6 6 L9 7 Z M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12",
  trendline: "M4 20 L20 4",
  hline: "M3 12 H21",
};

export const ICON_PATHS = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  gear: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z",
  star: "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z",
};
export type MarkupIcon = "up" | "down" | "gear" | "close" | "eye" | "eyeOff";
export function iconMarkup(name: MarkupIcon, size = 14): string {
  const path = ICON_PATHS[name === "eyeOff" ? "eye" : name];
  const extra = name === "gear" ? '<circle cx="12" cy="12" r="3"/>' : name === "eye" || name === "eyeOff" ? '<circle cx="12" cy="12" r="2.6"/>' : "";
  const slash = name === "eyeOff" ? '<path d="m4 4 16 16"/>' : "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/>${extra}${slash}</svg>`;
}
export const StarIcon = ({ size }: P) => <Icon size={size} path={ICON_PATHS.star} />;
export const SortIcon = ({ size = 12, dir }: P & { dir: "up" | "down" }) => <Icon size={size} path={ICON_PATHS[dir]} />;

export const ExpandIcon = ({ size = 16 }: P) => <Icon size={size} path="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />;
export const PanelIcon = ({ size = 16 }: P) => <Icon size={size}><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M15 4v16" /></Icon>;
export const CompareIcon = ({ size = 16 }: P) => <Icon size={size} path="M3 16l5-5 4 3 9-9M3 21l6-4 4 2 8-7" />;
