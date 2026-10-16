import { describe, expect, it } from 'vitest'
import { backupReason, isBackup, missReason, providerName } from './providers'

describe('backup explanations', () => {
  it('names what failed and where the backup is from', () => {
    expect(backupReason({ provider: 'archive', format: 'flac', noAnswer: true }, { provider: 'youtube', format: 'm4a' })).toBe('Internet Archive isn’t answering, so this is a backup copy from YouTube.')
    expect(backupReason({ provider: 'khinsider', format: 'flac', noAnswer: false }, { provider: 'youtube', format: 'm4a' })).toBe('KHInsider’s FLAC couldn’t be played, so this is a backup copy from YouTube.')
    expect(backupReason({ provider: 'archive', format: 'flac', noAnswer: true }, { provider: 'archive', format: 'mp3' })).toBe('The FLAC from Internet Archive didn’t load, so this is its MP3 instead.')
    expect(backupReason({ provider: 'download', format: 'flac', noAnswer: false }, { provider: 'khinsider', format: 'mp3' })).toBe('Your downloaded file couldn’t be played, so this streams from KHInsider.')
    expect(missReason({ provider: 'zophar', format: 'mp3', noAnswer: true })).toBe('Zophar’s Domain isn’t answering')
  })

  it('the same file again is no backup', () => {
    expect(isBackup({ provider: 'youtube', format: 'm4a', noAnswer: false }, { provider: 'youtube', format: 'm4a' })).toBe(false)
    expect(isBackup(null, { provider: 'youtube', format: 'm4a' })).toBe(false)
    expect(isBackup({ provider: 'archive', format: 'flac', noAnswer: true }, { provider: 'archive', format: 'mp3' })).toBe(true)
    expect(providerName('somesite')).toBe('Somesite')
  })
})
