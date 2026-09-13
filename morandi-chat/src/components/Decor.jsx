// 莫兰迪不规则色块装饰（纯 CSS 有机形状，无图片、无线稿、无渐变）

// 品牌标识：粉 / 紫 / 蜜桃 三块有机色块叠加
export function BlobMark({ className = "" }) {
  return (
    <span className={`relative inline-block ${className}`} aria-hidden="true">
      <span
        className="absolute left-[6%] top-[10%] w-[64%] h-[64%] bg-lilac"
        style={{ borderRadius: "63% 37% 54% 46% / 55% 48% 52% 45%" }}
      />
      <span
        className="absolute right-[2%] top-[30%] w-[54%] h-[54%] bg-blush"
        style={{ borderRadius: "42% 58% 61% 39% / 47% 55% 45% 53%" }}
      />
      <span
        className="absolute left-[22%] bottom-[2%] w-[50%] h-[50%] bg-peach"
        style={{ borderRadius: "58% 42% 43% 57% / 52% 43% 57% 48%" }}
      />
    </span>
  );
}

// 单个小色块（头像、点缀用），可包含内部小元素
export function BlobDot({ className = "", radius, children }) {
  return (
    <span
      className={`relative inline-block ${className}`}
      style={{ borderRadius: radius || "58% 42% 55% 45% / 52% 58% 42% 48%" }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

// 聊天区背景色块：从页面边缘自然探入，极淡、缓慢漂移
export function BackgroundBlobs() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* 右上：大块浅紫 */}
      <div className="absolute -top-32 -right-28 w-[27rem] h-[27rem] animate-drift">
        <div
          className="w-full h-full bg-lilac/45"
          style={{ borderRadius: "58% 42% 49% 51% / 55% 44% 56% 45%" }}
        />
      </div>
      {/* 右上叠加：灰紫小块 */}
      <div className="absolute top-44 right-8 w-40 h-40">
        <div
          className="w-full h-full bg-plum/40"
          style={{ borderRadius: "45% 55% 60% 40% / 50% 42% 58% 50%" }}
        />
      </div>
      {/* 左上：浅粉小块 */}
      <div className="absolute -top-20 left-[16%] w-48 h-48">
        <div
          className="w-full h-full bg-blush/40"
          style={{ borderRadius: "47% 53% 58% 42% / 55% 45% 55% 45%" }}
        />
      </div>
      {/* 左下：大块蜜桃 */}
      <div className="absolute -bottom-28 -left-24 w-[23rem] h-[23rem] animate-drift-slow">
        <div
          className="w-full h-full bg-peach/40"
          style={{ borderRadius: "52% 48% 58% 42% / 46% 56% 44% 54%" }}
        />
      </div>
      {/* 左下叠加：灰绿小块 */}
      <div className="absolute bottom-36 left-14 w-28 h-28">
        <div
          className="w-full h-full bg-sage/45"
          style={{ borderRadius: "60% 40% 45% 55% / 48% 60% 40% 52%" }}
        />
      </div>
    </div>
  );
}
