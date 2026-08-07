import React, { useEffect, useRef } from 'react'

/**
 * Constellation background for the login page — slowly drifting dots joined by
 * lines that fade out with distance. Sits behind the card at low opacity so the
 * page still reads as flat white.
 *
 * Colours are lifted from the logo wordmark (navy dots, periwinkle links) so the
 * effect ties to the brand without introducing a third palette.
 *
 * Deliberately cheap, because this renders before the user is even signed in:
 * - particle count scales with viewport area instead of being a fixed number,
 *   so a phone does not run a desktop's worth of work
 * - the loop is cancelled while the tab is hidden
 * - prefers-reduced-motion gets one static frame and no animation at all
 */

const DOT_RGB  = '13, 63, 82'    // #0d3f52 — logo navy
const LINE_RGB = '139, 150, 196' // #8b96c4 — logo periwinkle

/** Below this gap two particles are joined; the line fades to nothing at it. */
const LINK_DIST = 132
/** One particle per this many CSS px² — keeps density even across screens. */
const AREA_PER_PARTICLE = 17000
/** Ceiling so an ultrawide monitor cannot push the O(n²) link pass too far. */
const MAX_PARTICLES = 90

/** How close the cursor has to get before it pushes particles and links to them. */
const CURSOR_RADIUS = 150
/** Max px a particle is shoved per frame at the very centre of the cursor. */
const CURSOR_PUSH = 2.4

interface Particle { x: number; y: number; vx: number; vy: number; r: number }

export default function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let width = 0
    let height = 0
    let particles: Particle[] = []
    let frame = 0
    // Cursor in CSS px relative to the viewport. The canvas is fixed and
    // full-screen with pointerEvents:none, so it never receives events itself —
    // we listen on window, which also means the field still reacts while the
    // pointer is over the login card sitting on top of it.
    const cursor = { x: 0, y: 0, active: false }

    const seed = () => {
      const target = Math.min(
        MAX_PARTICLES,
        Math.max(12, Math.round((width * height) / AREA_PER_PARTICLE))
      )
      particles = Array.from({ length: target }, () => ({
        x:  Math.random() * width,
        y:  Math.random() * height,
        // Slow enough to read as ambient rather than as something moving.
        vx: (Math.random() - 0.5) * 0.24,
        vy: (Math.random() - 0.5) * 0.24,
        r:  1 + Math.random() * 1.4,
      }))
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      // Links first, dots painted over them so the joins look tucked behind.
      ctx.lineWidth = 1
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d2 = dx * dx + dy * dy
          if (d2 > LINK_DIST * LINK_DIST) continue
          // sqrt only for pairs that actually link.
          const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.3
          ctx.strokeStyle = `rgba(${LINE_RGB}, ${alpha})`
          ctx.beginPath()
          ctx.moveTo(particles[i].x, particles[i].y)
          ctx.lineTo(particles[j].x, particles[j].y)
          ctx.stroke()
        }
      }

      // Links from the cursor, drawn a touch stronger than particle-to-particle
      // ones so the field visibly answers the pointer.
      if (cursor.active) {
        for (const p of particles) {
          const dx = p.x - cursor.x
          const dy = p.y - cursor.y
          const d2 = dx * dx + dy * dy
          if (d2 > CURSOR_RADIUS * CURSOR_RADIUS) continue
          const alpha = (1 - Math.sqrt(d2) / CURSOR_RADIUS) * 0.45
          ctx.strokeStyle = `rgba(${LINE_RGB}, ${alpha})`
          ctx.beginPath()
          ctx.moveTo(cursor.x, cursor.y)
          ctx.lineTo(p.x, p.y)
          ctx.stroke()
        }
      }

      ctx.fillStyle = `rgba(${DOT_RGB}, 0.3)`
      for (const p of particles) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /**
     * Shove particles out of the cursor's way. This nudges position rather than
     * velocity on purpose: velocity would keep accelerating them and they would
     * end up flung into the edges, whereas a per-frame displacement opens a gap
     * that follows the pointer and closes again once it leaves.
     */
    const repel = () => {
      if (!cursor.active) return
      for (const p of particles) {
        const dx = p.x - cursor.x
        const dy = p.y - cursor.y
        const d  = Math.hypot(dx, dy)
        if (d > CURSOR_RADIUS || d < 0.01) continue
        const force = (1 - d / CURSOR_RADIUS) * CURSOR_PUSH
        p.x += (dx / d) * force
        p.y += (dy / d) * force
      }
    }

    const resize = () => {
      // Cap DPR at 2 — a 3x phone screen triples the fill cost for no visible
      // gain on shapes this soft.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width  = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width  = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
      if (reduced) draw()
    }

    const step = () => {
      repel()
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        // Bounce, and clamp back inside — without the clamp a particle that
        // resize() left off-canvas would flip its velocity every frame and sit
        // vibrating on the edge.
        if (p.x <= 0)      { p.x = 0;      p.vx = Math.abs(p.vx) }
        if (p.x >= width)  { p.x = width;  p.vx = -Math.abs(p.vx) }
        if (p.y <= 0)      { p.y = 0;      p.vy = Math.abs(p.vy) }
        if (p.y >= height) { p.y = height; p.vy = -Math.abs(p.vy) }
      }
      draw()
      frame = requestAnimationFrame(step)
    }

    const onVisibility = () => {
      cancelAnimationFrame(frame)
      if (!document.hidden && !reduced) frame = requestAnimationFrame(step)
    }

    const onPointerMove = (e: PointerEvent) => {
      // Touch only reports a point while a finger is down, so a stale "active"
      // cursor would leave a permanent hole after a tap. Mouse and pen only.
      if (e.pointerType === 'touch') { cursor.active = false; return }
      cursor.x = e.clientX
      cursor.y = e.clientY
      cursor.active = true
    }
    const onPointerLeave = () => { cursor.active = false }

    resize()
    if (!reduced) frame = requestAnimationFrame(step)

    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibility)
    if (!reduced) {
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      // Covers leaving the window entirely and alt-tabbing away mid-move.
      document.addEventListener('pointerleave', onPointerLeave)
      window.addEventListener('blur', onPointerLeave)
    }
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onPointerLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
