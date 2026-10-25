import type { ReactNode } from 'react';

type IconName =
  | 'brand'
  | 'pos'
  | 'orders'
  | 'purchases'
  | 'menu'
  | 'reports'
  | 'backups'
  | 'users'
  | 'logout';

const paths: Record<IconName, ReactNode> = {
  brand: (
    <>
      <path d="M5 3v18M19 3v18M5 8h14M8 12h8M8 16h5" />
      <path d="M3 3h18v18H3z" />
    </>
  ),
  pos: (
    <>
      <path d="M4 3h16v18H4zM8 7h8M8 11h2M14 11h2M8 15h2M14 15h2" />
    </>
  ),
  orders: (
    <>
      <path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4" />
      <path d="M9 3V2h6v1" />
    </>
  ),
  purchases: (
    <>
      <path d="M5 7h14l-1 14H6L5 7Z" />
      <path d="M8 7V5a4 4 0 0 1 8 0v2M8 12h8M10 16h4" />
    </>
  ),
  menu: (
    <>
      <path d="M5 6h14M5 12h14M5 18h14" />
      <path d="M8 4v4M15 10v4M11 16v4" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  backups: (
    <>
      <path d="M4 7h16v13H4zM7 7V3h10v4M8 12h8M8 16h5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  logout: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
