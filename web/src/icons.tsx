import type { ReactNode } from "react";

export type IconName =
  | "menu"
  | "close"
  | "sun"
  | "moon"
  | "users"
  | "settings"
  | "logout"
  | "send"
  | "plus"
  | "chevron"
  | "chevronRight"
  | "back"
  | "columns"
  | "book"
  | "chat"
  | "inspect"
  | "refresh"
  | "import"
  | "folder"
  | "folderPlus"
  | "file"
  | "download"
  | "upload"
  | "edit"
  | "trash"
  | "check";

const ICON_PATHS: Record<IconName, ReactNode> = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 6.3" />
      <path d="M17 14.6c2 .5 3.2 1.9 3.5 4.4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M15 8l4 4-4 4" />
      <path d="M19 12H9" />
    </>
  ),
  send: (
    <>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="M6 15l6-6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  back: (
    <>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M14.5 4v16" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.4C10 4.8 7.5 4.1 4 4.3v13.3c3.5-.2 6 .5 8 2.1 2-1.6 4.5-2.3 8-2.1V4.3c-3.5-.2-6 .5-8 2.1Z" />
      <path d="M12 6.4v13.3" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5.5h16v11H9.5L5 20v-3.5H4Z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  inspect: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
      <path d="M14 3v5h5" />
      <path d="M14 8h5" />
      <circle cx="17.5" cy="16.5" r="3" />
      <path d="M19.8 18.8 22 21" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4h-4" />
    </>
  ),
  import: (
    <>
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  folder: (
    <path d="M3 8a2 2 0 0 1 2-2h4l2 2.5h6A2 2 0 0 1 19 11v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
  folderPlus: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h4l2 2.5h6A2 2 0 0 1 19 11v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11.5v5M9.5 14h5" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 19V9" />
      <path d="m8 13 4-4 4 4" />
      <path d="M5 4h14" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16Z" />
      <path d="m14.5 5.5 4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l1 12.5h9L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
