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

export const GripIcon = ({ size = 14 }: P) => <Icon size={size} path="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" />;

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
export const ChevronIcon = ({ size = 12 }: P) => (
  <Icon size={size}>
    <path d="m7 10 5 5 5-5" />
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
export const TradesIcon = ({ size }: P) => <Icon size={size} path="M4 6h16M4 12h16M4 18h9" />;
export const BookIcon = ({ size }: P) => <Icon size={size} path="M12 4v16M3 7h6M5 12h4M2 17h7M15 7h6M15 12h4M15 17h6" />;
export const ProgramIcon = ({ size }: P) => <Icon size={size} path="M5 20v-8M11 20V4M17 20v-6M3 20h18" />;
export const OrderIcon = ({ size }: P) => <Icon size={size} path="M4 6h5v12H4zM15 6h5v12h-5zM9 12h6M12 9v6" />;
export const RankingIcon = ({ size }: P) => <Icon size={size} path="M3 20h18M5 20v-6h4v6M10 20V5h4v15M15 20v-9h4v9" />;
export const BrokersIcon = ({ size }: P) => <Icon size={size} path="M4 20h16M6 20V10l6-5 6 5v10M10 20v-6h4v6" />;
export const PreMarketIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 17h18" />
    <path d="M6 17a6 6 0 0 1 12 0" />
    <path d="M12 4v3M5.6 7.6l2.1 2.1M18.4 7.6l-2.1 2.1" />
  </Icon>
);
export const SlidersIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0" />
    <circle cx="15" cy="6" r="2.2" />
    <circle cx="9" cy="12" r="2.2" />
    <circle cx="17" cy="18" r="2.2" />
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
  eyeOff: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M4 4 L20 20",
  trash: "M4 6 H20 M9 6 V3 H15 V6 M6 6 L7 21 H17 L18 6 M10 10 V17 M14 10 V17",
  settings: "M9 3 H15 L16 6 L19 7 L21 10 L19 12 L20 16 L17 19 L14 18 L12 21 L9 19 L5 19 L3 15 L5 12 L3 9 L6 6 L9 7 Z M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12",
  trendline: "M4 20 L20 4",
  hline: "M3 12 H21",
  extendLeft: "M4 12 H20 M9 7 L4 12 L9 17 M17 9 V15",
  extendRight: "M4 12 H20 M15 7 L20 12 L15 17 M7 9 V15",
  layers: "M12 3 L3 8 L12 13 L21 8 Z M3 13 L12 18 L21 13 M3 17 L12 22 L21 17",
  presets: "M4 5 H20 M4 12 H14 M4 19 H11 M17 14 V20 M14 17 H20",
  tree: "M4 6 H20 M4 12 H20 M4 18 H12 M18 15 V21 M15 18 H21",
  calculator: "M5 3 H19 A2 2 0 0 1 21 5 V19 A2 2 0 0 1 19 21 H5 A2 2 0 0 1 3 19 V5 A2 2 0 0 1 5 3 Z M7 7 H17 V10 H7 Z M8 14 H8.01 M12 14 H12.01 M16 14 H16.01 M8 18 H8.01 M12 18 H12.01 M16 18 H16.01",
};

export const ICON_PATHS = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  gear: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z",
  star: "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  split: "M4 6h16M4 18h16M12 10v5m-3-2 3 3 3-3",
};
export type MarkupIcon = "up" | "down" | "gear" | "close" | "eye" | "eyeOff" | "grip" | "split";
export function iconMarkup(name: MarkupIcon, size = 14): string {
  const path = ICON_PATHS[name === "eyeOff" ? "eye" : name];
  const extra = name === "gear" ? '<circle cx="12" cy="12" r="3"/>' : name === "eye" || name === "eyeOff" ? '<circle cx="12" cy="12" r="2.6"/>' : "";
  const slash = name === "eyeOff" ? '<path d="m4 4 16 16"/>' : "";
  const strokeWidth = name === "grip" ? "2.4" : "1.5";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/>${extra}${slash}</svg>`;
}
export const StarIcon = ({ size }: P) => <Icon size={size} path={ICON_PATHS.star} />;
export const SortIcon = ({ size = 12, dir }: P & { dir: "up" | "down" }) => <Icon size={size} path={ICON_PATHS[dir]} />;
export const ExpandIcon = ({ size = 16 }: P) => <Icon size={size} path="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />;

export const CompareIcon = ({ size = 16 }: P) => <Icon size={size} path="M3 16l5-5 4 3 9-9M3 21l6-4 4 2 8-7" />;
export const GearIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Icon>
);

export const CogIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M10.0 5.4L10.1 1.6L13.9 1.6L14.0 5.4L16.7 7.0L20.1 5.1L22.0 8.5L18.7 10.4L18.7 13.6L22.0 15.5L20.1 18.9L16.7 17.0L14.0 18.6L13.9 22.4L10.1 22.4L10.0 18.6L7.3 17.0L3.9 18.9L2.0 15.5L5.3 13.6L5.3 10.4L2.0 8.5L3.9 5.1L7.3 7.0z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

export const WorkspaceIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16M3 12h9" />
  </Icon>
);
export const MarketIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 17l5-6 4 3 4-6 5 5" />
    <path d="M3 21h18" />
  </Icon>
);
export const HeatmapIcon = ({ size }: P) => (
  <Icon size={size}>
    <rect x="3" y="3" width="8" height="10" rx="1.5" />
    <rect x="13" y="3" width="8" height="6" rx="1.5" />
    <rect x="13" y="11" width="8" height="10" rx="1.5" />
    <rect x="3" y="15" width="8" height="6" rx="1.5" />
  </Icon>
);
export const EtfIcon = ({ size }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4v8l6 4" />
  </Icon>
);
export const WhaleIcon = ({ size }: P) => (
  <Icon size={size}>
    <path d="M3 15c2-4 5.5-6 9.5-6 3.2 0 5.8 1.4 7.5 3.8-1.4 2.4-4 4.2-7.5 4.2H6l-3 2v-4z" />
    <path d="M18 11l3-2.5M18 13.5l3 2" />
    <circle cx="9.5" cy="12.5" r="0.8" fill="currentColor" stroke="none" />
  </Icon>
);

export const WarningIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4.5M12 17.2h.01" />
  </Icon>
);
export const InfoIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
);
export const RetryIcon = ({ size = 16 }: P) => <Icon size={size} path="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" />;
export const EmptyBoxIcon = ({ size = 24 }: P) => (
  <Icon size={size}>
    <path d="M3.5 13 6 5.5h12l2.5 7.5" />
    <path d="M3.5 13v6h17v-6h-5.5a3 3 0 0 1-6 0z" />
  </Icon>
);
export const KeyboardIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10" />
  </Icon>
);
export const WalletIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="3" y="8" width="18" height="11.5" rx="2" />
    <path d="M16.5 13.8h.01" />
  </Icon>
);
export const ExternalLinkIcon = ({ size = 16 }: P) => <Icon size={size} path="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V14M13.5 4H20v6.5M20 4l-9 9" />;
export const CollapseIcon = ({ size = 16 }: P) => <Icon size={size} path="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" />;
export const DockIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 9v11" />
  </Icon>
);
export const MinimizeIcon = ({ size = 16 }: P) => <Icon size={size} path="M5 19h14" />;
export const CheckCircleIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.3 2.4 2.4 4.6-5" />
  </Icon>
);
export const CloudIcon = ({ size = 24 }: P) => <Icon size={size} path="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a4 4 0 0 1-.5 8z" />;
export const DocumentIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M6.5 3h7.8L19 7.7V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5M8 13h8M8 17h5" />
  </Icon>
);
export const PauseIcon = ({ size = 14 }: P) => (
  <Icon size={size}>
    <path d="M9 6v12M15 6v12" />
  </Icon>
);
export const SyncIcon = ({ size = 12 }: P) => (
  <Icon size={size}>
    <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
  </Icon>
);
export const UserIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);
export const DatabaseIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
  </Icon>
);
export const BellIcon = ({ size = 16 }: P) => (
  <Icon size={size}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />
  </Icon>
);
export const ClockIcon = ({ size = 12 }: P) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
export const UndoIcon = ({ size = 16 }: P) => <Icon size={size} path="M9 8H15a4.5 4.5 0 0 1 0 9H8M9 4 5 8l4 4" />;
export const LogScaleIcon = ({ size = 16 }: P) => <Icon size={size} path="M4 20h16M4 4v16M7 17c4 0 5-3 7-6s3-4 5-5" />;
