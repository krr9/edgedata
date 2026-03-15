import { useId } from 'react';

export interface EdgeDataLogoProps {
  badge?: string | null;
  className?: string;
  markClassName?: string;
  size?: number;
  stacked?: boolean;
  wordmark?: boolean;
}

export function EdgeDataLogo({
  badge = null,
  className,
  markClassName,
  size = 40,
  stacked = false,
  wordmark = true
}: EdgeDataLogoProps) {
  return (
    <span className={['ed-logo', stacked ? 'stacked' : '', className].filter(Boolean).join(' ')}>
      <EdgeDataMark size={size} className={markClassName} />
      {wordmark ? (
        <span className="ed-logo-lockup">
          <span className="ed-logo-wordmark">
            <span className="ed-logo-wordmark-edge">Edge</span>
            <span className="ed-logo-wordmark-data">Data</span>
          </span>
          {badge ? <span className="ed-logo-badge">{badge}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

interface EdgeDataMarkProps {
  className?: string;
  size?: number;
}

function EdgeDataMark({ className, size = 40 }: EdgeDataMarkProps) {
  const id = useId().replace(/:/g, '');
  const bgId = `${id}-bg`;
  const glowId = `${id}-glow`;
  const frameId = `${id}-frame`;
  const coreId = `${id}-core`;
  const arcId = `${id}-arc`;
  const nodeId = `${id}-node`;

  return (
    <svg
      aria-hidden="true"
      className={['ed-logo-mark', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={bgId} x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#06111E" />
          <stop offset="0.5" stopColor="#0D3966" />
          <stop offset="1" stopColor="#1493FF" />
        </linearGradient>
        <radialGradient id={glowId} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(46 17) rotate(127.875) scale(41.1185)">
          <stop stopColor="#7EE7FF" stopOpacity="0.85" />
          <stop offset="1" stopColor="#7EE7FF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={frameId} x1="12" y1="10" x2="54" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7FE7FF" stopOpacity="0.85" />
          <stop offset="0.45" stopColor="#B8D9FF" stopOpacity="0.65" />
          <stop offset="1" stopColor="#F8FBFF" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id={coreId} x1="18" y1="16" x2="51" y2="47" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F8FDFF" />
          <stop offset="1" stopColor="#D5ECFF" />
        </linearGradient>
        <linearGradient id={arcId} x1="40" y1="16" x2="56" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#73ECFF" />
          <stop offset="1" stopColor="#6B8BFF" />
        </linearGradient>
        <linearGradient id={nodeId} x1="44" y1="20" x2="53" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFD97A" />
          <stop offset="1" stopColor="#FF7A1A" />
        </linearGradient>
      </defs>

      <rect x="4" y="4" width="56" height="56" rx="18" fill={`url(#${bgId})`} />
      <rect x="4" y="4" width="56" height="56" rx="18" fill={`url(#${glowId})`} />
      <rect x="5.25" y="5.25" width="53.5" height="53.5" rx="16.75" stroke={`url(#${frameId})`} strokeOpacity="0.7" strokeWidth="1.5" />
      <path d="M13 18.5C13 15.4624 15.4624 13 18.5 13H39L29.5 51H18.5C15.4624 51 13 48.5376 13 45.5V18.5Z" fill="white" fillOpacity="0.04" />

      <rect x="17.5" y="16.8" width="7.4" height="30.4" rx="3.7" fill={`url(#${coreId})`} />
      <path d="M22 18.7H40.5C42.8738 18.7 44.8 20.6262 44.8 23C44.8 25.3738 42.8738 27.3 40.5 27.3H22V18.7Z" fill={`url(#${coreId})`} />
      <path d="M22 28.85H47.5C49.8738 28.85 51.8 30.7762 51.8 33.15C51.8 35.5238 49.8738 37.45 47.5 37.45H22V28.85Z" fill={`url(#${coreId})`} />
      <path d="M22 39H34.75C37.1238 39 39.05 40.9262 39.05 43.3C39.05 45.6738 37.1238 47.6 34.75 47.6H22V39Z" fill={`url(#${coreId})`} />

      <path
        d="M47.6 22.95C50.9 25.35 52.65 28.85 52.65 33.1C52.65 37.15 49.95 40.7 43.4 43.45"
        stroke={`url(#${arcId})`}
        strokeLinecap="round"
        strokeWidth="2.75"
      />
      <path
        d="M45.35 14.7C50.7 18.35 54 24.7 54 31.9C54 39.45 50.35 46 44 49.75"
        stroke={`url(#${arcId})`}
        strokeLinecap="round"
        strokeOpacity="0.38"
        strokeWidth="1.8"
      />

      <circle cx="48.05" cy="23.05" r="3.65" fill={`url(#${nodeId})`} />
      <circle cx="52.1" cy="33.15" r="3.9" fill={`url(#${nodeId})`} />
      <circle cx="43.15" cy="43.35" r="3.55" fill={`url(#${nodeId})`} />
      <circle cx="48.05" cy="23.05" r="1.05" fill="#FFF8E8" />
      <circle cx="52.1" cy="33.15" r="1.1" fill="#FFF8E8" />
      <circle cx="43.15" cy="43.35" r="1" fill="#FFF8E8" />
    </svg>
  );
}
