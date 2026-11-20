export function WaveBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden z-0"
    >
      {/* Top-right luminous violet ambient glow */}
      <div
        className="absolute -top-48 right-[-10%] h-[620px] w-[680px] rounded-full opacity-45 blur-[130px]"
        style={{
          background:
            'radial-gradient(circle at center, rgba(139, 92, 246, 0.55) 0%, rgba(109, 40, 217, 0.25) 45%, transparent 72%)',
        }}
      />
      {/* Left subtle deep indigo wash */}
      <div
        className="absolute top-[28%] -left-40 h-[520px] w-[520px] rounded-full opacity-30 blur-[140px]"
        style={{
          background:
            'radial-gradient(circle at center, rgba(91, 33, 182, 0.45) 0%, transparent 70%)',
        }}
      />

      {/* Flowing translucent wave ribbons inspired by the UI reference */}
      <svg
        className="absolute top-0 right-0 w-[920px] h-[720px] opacity-35"
        viewBox="0 0 920 720"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="waveGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.45" />
            <stop offset="55%" stopColor="#8B5CF6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#4C1D95" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="waveGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.35" />
            <stop offset="60%" stopColor="#7C3AED" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#2E1065" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M210 -40C290 130 130 280 340 420C550 560 760 450 960 640"
          stroke="url(#waveGrad1)"
          strokeWidth="1.5"
        />
        <path
          d="M250 -40C330 140 175 295 385 430C595 565 790 465 980 650"
          stroke="url(#waveGrad1)"
          strokeWidth="1.2"
        />
        <path
          d="M290 -40C370 150 220 310 430 440C640 570 820 480 1000 660"
          stroke="url(#waveGrad2)"
          strokeWidth="1"
        />
        <path
          d="M330 -40C410 160 265 325 475 450C685 575 850 495 1020 670"
          stroke="url(#waveGrad2)"
          strokeWidth="0.9"
        />
        <path
          d="M370 -40C450 170 310 340 520 460C730 580 880 510 1040 680"
          stroke="url(#waveGrad1)"
          strokeWidth="0.75"
        />
        <path
          d="M410 -40C490 180 355 355 565 470C775 585 910 525 1060 690"
          stroke="url(#waveGrad2)"
          strokeWidth="0.65"
        />
      </svg>
    </div>
  );
}
