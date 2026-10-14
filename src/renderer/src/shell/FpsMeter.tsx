// Frame-time meter (settings.interface.showFps, toggle with Mod+Shift+F). Text updates 4×/s;
// the mini graph shows the last 90 frame times (green < 1.25× refresh budget, amber, red).
import { useEffect, useRef } from 'react'
import { ticker, TickPriority } from '../motion/ticker'
import { useSettings } from '../state/settings'

const N = 90

export function FpsMeter() {
  const show = useSettings((s) => s.interface.showFps)
  return show ? <Meter /> : null
}

function Meter() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const fpsEl = useRef<HTMLSpanElement>(null)
  const msEl = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const samples = new Float32Array(N)
    let head = 0
    let lastText = 0
    let budget = 1000 / 60
    const ctx = canvas.current?.getContext('2d')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.current) {
      canvas.current.width = N * dpr
      canvas.current.height = 22 * dpr
    }
    return ticker.add((_dt, now) => {
      const raw = ticker.rawDt
      samples[head] = raw
      head = (head + 1) % N
      // estimate the display budget from the fastest recent frames
      let min = 1e9
      for (let i = 0; i < N; i++) if (samples[i] > 0 && samples[i] < min) min = samples[i]
      if (min < 1e9) budget = budget * 0.98 + Math.max(4, min) * 0.02
      if (now - lastText > 250) {
        lastText = now
        let sum = 0
        let n = 0
        let worst = 0
        for (let i = 0; i < N; i++) {
          if (!samples[i]) continue
          sum += samples[i]
          n++
          if (samples[i] > worst) worst = samples[i]
        }
        const avg = n ? sum / n : 16.7
        if (fpsEl.current) fpsEl.current.textContent = String(Math.round(1000 / avg))
        if (msEl.current) msEl.current.textContent = `${avg.toFixed(1)} ms · max ${worst.toFixed(1)}`
        if (root.current) root.current.dataset.state = worst > budget * 2.2 ? 'bad' : worst > budget * 1.4 ? 'warn' : 'good'
      }
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, N, 22)
      for (let i = 0; i < N; i++) {
        const v = samples[(head + i) % N]
        if (!v) continue
        const h = Math.min(22, (v / (budget * 3)) * 22)
        ctx.fillStyle = v > budget * 2 ? '#ff5f7a' : v > budget * 1.25 ? '#ffcc55' : '#5ee6a0'
        ctx.fillRect(i, 22 - h, 0.8, h)
      }
    }, TickPriority.measure)
  }, [])

  return (
    <div ref={root} className="g-fps" data-state="good" aria-hidden>
      <canvas ref={canvas} className="g-fps__graph" style={{ width: N, height: 22 }} />
      <div className="g-fps__text">
        <span ref={fpsEl} className="g-fps__num tnum">
          –
        </span>
        <span className="g-fps__unit">fps</span>
        <span ref={msEl} className="g-fps__ms tnum" />
      </div>
    </div>
  )
}
