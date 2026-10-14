// Placeholder root; replaced by the shell workstream (theme, background layer, toolbar, screens).
import { usePlayer } from './state/player'

export default function App() {
  const status = usePlayer((s) => s.status)
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: '#0f0d17', color: '#e8e4f8', fontFamily: 'Outfit Variable, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: 8 }}>GHOST</div>
        <div style={{ opacity: 0.6 }}>Game Haven OST · player {status}</div>
      </div>
    </div>
  )
}
