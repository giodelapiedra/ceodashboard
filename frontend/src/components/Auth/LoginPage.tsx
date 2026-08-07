import React, { useState } from 'react'
import { useAuthStore } from '../../store/auth.store'
import logoSrc from '../../assets/physioward-logo.png'
import ParticleField from './ParticleField'

export default function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const { login }               = useAuthStore()

  const handleSubmit = async () => {
    if (!email || !password) return setError('Enter email and password')
    setLoading(true); setError('')
    try {
      await login(email, password)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Invalid email or password')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#fdfdfd',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'DM Sans', sans-serif",
      padding: 16,
      position: 'relative', overflow: 'hidden',
    }}>
      <ParticleField />

      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes spin { to { transform: rotate(360deg) } }
        .login-card { animation: fadeUp 0.35s ease }
        .login-input:focus { outline: none; border-color: #0f6e56 !important; box-shadow: 0 0 0 3px rgba(15,110,86,0.12) }
        .login-btn:hover:not(:disabled) { background: #0a5040 !important }
        .login-btn:active:not(:disabled) { transform: scale(0.98) }
        @media (prefers-reduced-motion: reduce) { .login-card { animation: none } }
      `}</style>

      {/* zIndex lifts the card off the canvas, which is fixed at zIndex 0. */}
      <div className="login-card" style={{
        position: 'relative', zIndex: 1,
        background: '#fff', borderRadius: 16, padding: '44px 40px',
        width: '100%', maxWidth: 390,
        boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 12px 32px rgba(16,24,40,0.06)',
        border: '1px solid #eef0f3',
      }}>
        {/* Logo — the wordmark already reads "PhysioWard Sports & Rehab", so
            there is no separate name line under it. */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img
            src={logoSrc}
            alt="PhysioWard Sports & Rehab"
            style={{
              width: '100%', maxWidth: 216, height: 'auto',
              display: 'block', margin: '0 auto 18px',
            }}
          />
          <div style={{
            fontSize: 11, color: '#9ca3af', fontWeight: 500,
            letterSpacing: '0.16em', textTransform: 'uppercase',
          }}>
            Internal Portal
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 8, padding: '10px 14px',
            fontSize: 13, color: '#b91c1c', marginBottom: 20,
          }}>
            {error}
          </div>
        )}

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            className="login-input"
            type="email"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={{
              width: '100%', padding: '11px 14px',
              border: '1px solid #e5e7eb', borderRadius: 8,
              fontSize: 14, fontFamily: "'DM Sans', sans-serif",
              color: '#111827', transition: 'border-color 0.15s, box-shadow 0.15s',
              boxSizing: 'border-box',
            }}
          />
          <input
            className="login-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            style={{
              width: '100%', padding: '11px 14px',
              border: '1px solid #e5e7eb', borderRadius: 8,
              fontSize: 14, fontFamily: "'DM Sans', sans-serif",
              color: '#111827', transition: 'border-color 0.15s, box-shadow 0.15s',
              boxSizing: 'border-box',
            }}
          />
          <button
            className="login-btn"
            onClick={handleSubmit}
            disabled={loading}
            style={{
              width: '100%', padding: '12px',
              background: loading ? '#9ca3af' : '#0f6e56',
              color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {loading ? (
              <>
                <span style={{
                  width: 14, height: 14,
                  border: '2px solid rgba(255,255,255,0.4)',
                  borderTop: '2px solid #fff',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'spin 0.7s linear infinite',
                }} />
                Signing in...
              </>
            ) : 'Sign in'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#9ca3af' }}>
          Internal use only
        </div>
      </div>
    </div>
  )
}
