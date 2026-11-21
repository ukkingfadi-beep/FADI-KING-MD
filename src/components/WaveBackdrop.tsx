export function WaveBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden z-0 bg-[#06040E]"
    >
      {/* Top atmospheric midnight-violet dome */}
      <div
        className="absolute -top-56 left-1/2 -translate-x-1/2 h-[560px] w-[960px] rounded-full opacity-45 blur-[130px]"
        style={{
          background:
            'radial-gradient(circle at center, rgba(124, 58, 237, 0.52) 0%, rgba(76, 29, 149, 0.24) 50%, transparent 75%)',
        }}
      />
      {/* Right-side cosmic purple flare */}
      <div
        className="absolute top-[24%] -right-36 h-[560px] w-[560px] rounded-full opacity-45 blur-[135px]"
        style={{
          background:
            'radial-gradient(circle at center, rgba(147, 51, 234, 0.5) 0%, rgba(109, 40, 217, 0.2) 50%, transparent 72%)',
        }}
      />
      {/* Left-side deep indigo nebula glow */}
      <div
        className="absolute top-[38%] -left-44 h-[540px] w-[540px] rounded-full opacity-40 blur-[140px]"
        style={{
          background:
            'radial-gradient(circle at center, rgba(91, 33, 182, 0.5) 0%, transparent 72%)',
        }}
      />

      {/* Subtle translucent wave lines across the canvas */}
      <svg
        className="absolute top-0 right-0 w-[1080px] h-[760px] opacity-30"
        viewBox="0 0 1080 760"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="waveGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#DDD6FE" stopOpacity="0.4" />
            <stop offset="55%" stopColor="#8B5CF6" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#4C1D95" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="waveGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.32" />
            <stop offset="60%" stopColor="#7C3AED" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#2E1065" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M210 -40C290 130 130 280 340 420C550 560 760 450 960 640"
          stroke="url(#waveGrad1)"
          strokeWidth="1.4"
        />
        <path
          d="M260 -40C340 140 185 295 395 430C605 565 810 465 1000 650"
          stroke="url(#waveGrad1)"
          strokeWidth="1.1"
        />
        <path
          d="M310 -40C390 150 240 310 450 440C660 570 860 480 1040 660"
          stroke="url(#waveGrad2)"
          strokeWidth="0.95"
        />
        <path
          d="M360 -40C440 160 295 325 505 450C715 575 910 495 1080 670"
          stroke="url(#waveGrad2)"
          strokeWidth="0.8"
        />
      </svg>
    </div>
  );
}
