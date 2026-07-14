import type { ReactNode } from "react";

type IconProps = { size?: number; className?: string };

function IconBase({ children, size = 18, className }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const ArrowLeftIcon = (props: IconProps) => <IconBase {...props}><path d="m15 18-6-6 6-6" /></IconBase>;
export const CameraIcon = (props: IconProps) => <IconBase {...props}><path d="M14.5 4 16 6h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l1.5-2h5Z" /><circle cx="12" cy="13" r="3.5" /></IconBase>;
export const ChevronDownIcon = (props: IconProps) => <IconBase {...props}><path d="m6 9 6 6 6-6" /></IconBase>;
export const CloseIcon = (props: IconProps) => <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
export const HeartIcon = (props: IconProps) => <IconBase {...props}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" /></IconBase>;
export const LogOutIcon = (props: IconProps) => <IconBase {...props}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></IconBase>;
export const PencilIcon = (props: IconProps) => <IconBase {...props}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></IconBase>;
export const RefreshIcon = (props: IconProps) => <IconBase {...props}><path d="M20 11a8.1 8.1 0 0 0-14.9-4M4 4v5h5M4 13a8.1 8.1 0 0 0 14.9 4M20 20v-5h-5" /></IconBase>;
export const ReplyIcon = (props: IconProps) => <IconBase {...props}><path d="m9 17-5-5 5-5M4 12h10a6 6 0 0 1 6 6v1" /></IconBase>;
export const SendIcon = (props: IconProps) => <IconBase {...props}><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13" /></IconBase>;
export const UserIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></IconBase>;

type AvatarProps = {
  name: string;
  url?: string | null;
  size?: "small" | "medium" | "large";
  status?: "online" | "offline";
};

export function Avatar({ name, url, size = "medium", status }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("tr-TR"))
    .join("") || "S";

  return (
    <span className={`avatar avatar-${size}${status ? ` avatar-${status}` : ""}`} title={name}>
      {url ? <img src={url} alt="" /> : <span>{initials}</span>}
    </span>
  );
}
