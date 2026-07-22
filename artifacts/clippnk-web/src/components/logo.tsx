export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="clipp'n'k logo"
    >
      <rect width="1024" height="1024" rx="220" fill="#E8401A" />
      <ellipse cx="730" cy="512" rx="150" ry="106" fill="none" stroke="white" strokeWidth="64" />
      <rect x="544" y="468" width="110" height="88" fill="white" />
      <rect x="96" y="380" width="476" height="264" rx="52" fill="white" />
      <circle cx="334" cy="512" r="76" fill="#E8401A" />
      <circle cx="334" cy="512" r="46" fill="white" />
    </svg>
  );
}
