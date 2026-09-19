// 流式文本 hook：把 state/liveStreamBuffer.js 的纯逻辑接进 React。
// 返回的名字与原来 App 里的局部函数保持一致，方便替换。

import { useRef, useState } from "react";
import { createLiveStreamBuffer } from "../state/liveStreamBuffer";

export default function useLiveStream() {
  const [liveStream, setLiveStream] = useState(null);
  const bufferRef = useRef(null);
  if (!bufferRef.current) {
    bufferRef.current = createLiveStreamBuffer({ onSnapshot: setLiveStream });
  }
  const buffer = bufferRef.current;
  return {
    liveStream,
    beginLiveStream: (convId, nodeId, baseText = "") => buffer.begin(convId, nodeId, baseText),
    appendLiveStream: (chunk) => buffer.appendText(chunk),
    appendLiveReasoning: (chunk) => buffer.appendReasoning(chunk),
    endLiveStream: () => buffer.end(),
  };
}
