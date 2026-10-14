//! Tiny synthetic game-music files for tests (no fixtures to ship, exact known timing).

/// One tone segment: (PSG period, length in 44.1 kHz samples).
pub type Segment = (u16, u32);

/// SN76489 clock of the Master System.
pub const PSG_CLOCK: u32 = 3_579_545;

/// Frequency an SN76489 tone period produces.
pub fn psg_freq(period: u16) -> f64 {
    PSG_CLOCK as f64 / (32.0 * period as f64)
}

/// A VGM (v1.50) for the SN76489: `intro` segments, then `body` segments that loop forever
/// (no loop if `body` is empty). Channel 0 plays each segment's tone at full volume.
pub fn vgm_psg(intro: &[Segment], body: &[Segment]) -> Vec<u8> {
    fn tone(cmds: &mut Vec<u8>, period: u16, samples: u32) {
        cmds.extend_from_slice(&[0x50, 0x80 | (period & 0x0F) as u8, 0x50, ((period >> 4) & 0x3F) as u8]);
        let mut left = samples;
        while left > 0 {
            let n = left.min(0xFFFF);
            cmds.extend_from_slice(&[0x61, (n & 0xFF) as u8, (n >> 8) as u8]);
            left -= n;
        }
    }
    let mut cmds = vec![0x50, 0x90]; // channel 0 volume: loudest
    for &(p, n) in intro {
        tone(&mut cmds, p, n);
    }
    let loop_pos = cmds.len();
    for &(p, n) in body {
        tone(&mut cmds, p, n);
    }
    cmds.push(0x66);
    let intro_len: u32 = intro.iter().map(|s| s.1).sum();
    let body_len: u32 = body.iter().map(|s| s.1).sum();
    let mut h = vec![0u8; 0x40];
    h[..4].copy_from_slice(b"Vgm ");
    let total_size = 0x40 + cmds.len();
    h[0x04..0x08].copy_from_slice(&((total_size - 4) as u32).to_le_bytes());
    h[0x08..0x0C].copy_from_slice(&0x150u32.to_le_bytes());
    h[0x0C..0x10].copy_from_slice(&PSG_CLOCK.to_le_bytes());
    h[0x18..0x1C].copy_from_slice(&(intro_len + body_len).to_le_bytes());
    if !body.is_empty() {
        h[0x1C..0x20].copy_from_slice(&((0x40 + loop_pos - 0x1C) as u32).to_le_bytes());
        h[0x20..0x24].copy_from_slice(&body_len.to_le_bytes());
    }
    h[0x24..0x28].copy_from_slice(&60u32.to_le_bytes());
    h[0x28..0x2A].copy_from_slice(&0x0009u16.to_le_bytes());
    h[0x2A] = 16;
    h[0x34..0x38].copy_from_slice(&0x0Cu32.to_le_bytes());
    h.extend_from_slice(&cmds);
    h
}

/// NES pulse frequency for a timer period.
pub fn nes_pulse_freq(timer: u8) -> f64 {
    1_789_773.0 / (16.0 * (timer as f64 + 1.0))
}

/// An NSF with one song per entry of `timers`: song N holds a 50% square on pulse 1 at
/// `nes_pulse_freq(timers[N])` forever.
pub fn nsf_songs(timers: &[u8], title: &str) -> Vec<u8> {
    let mut h = vec![0u8; 0x80];
    h[..5].copy_from_slice(b"NESM\x1A");
    h[5] = 1;
    h[6] = timers.len() as u8;
    h[7] = 1;
    h[0x08..0x0A].copy_from_slice(&0x8000u16.to_le_bytes()); // load
    h[0x0A..0x0C].copy_from_slice(&0x8000u16.to_le_bytes()); // init
    h[0x0C..0x0E].copy_from_slice(&0x801Cu16.to_le_bytes()); // play
    for (i, b) in title.bytes().take(31).enumerate() {
        h[0x0E + i] = b;
    }
    h[0x2E..0x2E + 5].copy_from_slice(b"ghost");
    h[0x6E..0x70].copy_from_slice(&16_639u16.to_le_bytes());
    h[0x78..0x7A].copy_from_slice(&19_997u16.to_le_bytes());
    #[rustfmt::skip]
    let code: [u8; 29] = [
        0xAA,             // TAX            (A = song index)
        0xA9, 0x0F,       // LDA #$0F
        0x8D, 0x15, 0x40, // STA $4015      enable channels
        0xA9, 0xBF,       // LDA #$BF       50% duty, halt length, constant volume 15
        0x8D, 0x00, 0x40, // STA $4000
        0xA9, 0x08,       // LDA #$08       sweep off
        0x8D, 0x01, 0x40, // STA $4001
        0xBD, 0x1D, 0x80, // LDA $801D,X    timer low from the table
        0x8D, 0x02, 0x40, // STA $4002
        0xA9, 0x00,       // LDA #$00
        0x8D, 0x03, 0x40, // STA $4003      timer high 0, restart
        0x60,             // RTS
        0x60,             // play: RTS
    ];
    h.extend_from_slice(&code);
    h.extend_from_slice(timers);
    h
}

/// A 4-channel ProTracker MOD: one 64-row pattern with a looped square sample on channel 1
/// (C-3), played once per pass (7.68 s at speed 6 / 125 BPM), restarting at order 0.
pub fn mod_square() -> Vec<u8> {
    let mut m = vec![0u8; 20];
    m[..12].copy_from_slice(b"ghost square");
    for i in 0..31 {
        let mut s = [0u8; 30];
        if i == 0 {
            s[..6].copy_from_slice(b"square");
            s[22..24].copy_from_slice(&16u16.to_be_bytes()); // 16 words = 32 bytes
            s[25] = 64; // volume
            s[26..28].copy_from_slice(&0u16.to_be_bytes()); // loop start
            s[28..30].copy_from_slice(&16u16.to_be_bytes()); // loop length
        } else {
            s[28..30].copy_from_slice(&1u16.to_be_bytes());
        }
        m.extend_from_slice(&s);
    }
    m.push(1); // song length
    m.push(127);
    let mut orders = [0u8; 128];
    orders[0] = 0;
    m.extend_from_slice(&orders);
    m.extend_from_slice(b"M.K.");
    let mut pattern = vec![0u8; 64 * 4 * 4];
    // Row 0, channel 0: sample 1, period 214 (C-3).
    pattern[0] = 0x00;
    pattern[1] = 214;
    pattern[2] = 0x10;
    pattern[3] = 0x00;
    m.extend_from_slice(&pattern);
    m.extend((0..32).map(|i| if i < 16 { 0x60u8 } else { 0xA0u8 }));
    m
}

/// 16-bit PCM RIFF WAVE (stereo when `stereo`), optionally with a `smpl` forward loop
/// `[start, end)` in frames.
pub fn wav_pcm16(rate: u32, frames: &[[i16; 2]], stereo: bool, looped: Option<(u32, u32)>) -> Vec<u8> {
    let ch: u16 = if stereo { 2 } else { 1 };
    let mut data = Vec::with_capacity(frames.len() * 2 * ch as usize);
    for f in frames {
        data.extend_from_slice(&f[0].to_le_bytes());
        if stereo {
            data.extend_from_slice(&f[1].to_le_bytes());
        }
    }
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&1u16.to_le_bytes());
    fmt.extend_from_slice(&ch.to_le_bytes());
    fmt.extend_from_slice(&rate.to_le_bytes());
    fmt.extend_from_slice(&(rate * 2 * ch as u32).to_le_bytes());
    fmt.extend_from_slice(&(2 * ch).to_le_bytes());
    fmt.extend_from_slice(&16u16.to_le_bytes());
    let mut chunks = Vec::new();
    let mut chunk = |id: &[u8], body: &[u8]| {
        chunks.extend_from_slice(id);
        chunks.extend_from_slice(&(body.len() as u32).to_le_bytes());
        chunks.extend_from_slice(body);
        if body.len() % 2 == 1 {
            chunks.push(0);
        }
    };
    chunk(b"fmt ", &fmt);
    if let Some((start, end)) = looped {
        let mut smpl = vec![0u8; 0x24];
        smpl[0x1C..0x20].copy_from_slice(&1u32.to_le_bytes());
        let mut l = vec![0u8; 0x18];
        l[0x08..0x0C].copy_from_slice(&start.to_le_bytes());
        l[0x0C..0x10].copy_from_slice(&(end - 1).to_le_bytes()); // inclusive end
        smpl.extend_from_slice(&l);
        chunk(b"smpl", &smpl);
    }
    chunk(b"data", &data);
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + chunks.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(&chunks);
    out
}

/// Square wave frames: `freq` Hz at `rate`, amplitude `amp` (i16).
pub fn square_frames(rate: u32, freq: f64, frames: usize, amp: i16) -> Vec<[i16; 2]> {
    (0..frames)
        .map(|i| {
            let phase = (i as f64 * freq / rate as f64).fract();
            let v = if phase < 0.5 { amp } else { -amp };
            [v, v]
        })
        .collect()
}

/// Zero-crossing frequency estimate of channel 0 of interleaved audio.
pub fn zero_cross_freq(interleaved: &[f32], channels: usize, rate: u32) -> f64 {
    let ch0: Vec<f32> = interleaved.iter().step_by(channels.max(1)).copied().collect();
    let mean = ch0.iter().map(|&v| v as f64).sum::<f64>() / ch0.len().max(1) as f64;
    let mut crossings = 0usize;
    let mut prev = ch0.first().map(|&v| v as f64 - mean).unwrap_or(0.0);
    for &v in ch0.iter().skip(1) {
        let cur = v as f64 - mean;
        if prev < 0.0 && cur >= 0.0 {
            crossings += 1;
        }
        if cur != 0.0 {
            prev = cur;
        }
    }
    crossings as f64 * rate as f64 / ch0.len().max(1) as f64
}

/// RMS of interleaved audio.
pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

/// A Wii BRSTM (version 1.0) with PCM16 big-endian stereo data in 0x2000-byte interleave blocks,
/// looping from `loop_start` to the end. `frames.len()` must be a multiple of 4096.
pub fn brstm_pcm16(rate: u16, frames: &[[i16; 2]], loop_start: u32) -> Vec<u8> {
    const BLOCK: usize = 0x2000;
    assert_eq!(frames.len() % (BLOCK / 2), 0);
    let blocks = frames.len() / (BLOCK / 2);
    let head_off = 0x40usize;
    let head_size = 0x60usize;
    let data_off = head_off + head_size;
    let audio_off = data_off + 0x20;
    let mut data = Vec::with_capacity(frames.len() * 4);
    for b in 0..blocks {
        for ch in 0..2 {
            for f in &frames[b * BLOCK / 2..(b + 1) * BLOCK / 2] {
                data.extend_from_slice(&f[ch].to_be_bytes());
            }
        }
    }
    let total = audio_off + data.len();
    let mut out = vec![0u8; audio_off];
    out[..4].copy_from_slice(b"RSTM");
    out[4..6].copy_from_slice(&0xFEFFu16.to_be_bytes());
    out[6..8].copy_from_slice(&0x0100u16.to_be_bytes());
    out[8..12].copy_from_slice(&(total as u32).to_be_bytes());
    out[0x0C..0x0E].copy_from_slice(&(head_off as u16).to_be_bytes());
    out[0x0E..0x10].copy_from_slice(&2u16.to_be_bytes());
    out[0x10..0x14].copy_from_slice(&(head_off as u32).to_be_bytes());
    out[0x14..0x18].copy_from_slice(&(head_size as u32).to_be_bytes());
    out[0x18..0x1C].copy_from_slice(&(data_off as u32).to_be_bytes());
    out[0x1C..0x20].copy_from_slice(&((total - data_off) as u32).to_be_bytes());
    out[head_off..head_off + 4].copy_from_slice(b"HEAD");
    out[head_off + 4..head_off + 8].copy_from_slice(&(head_size as u32).to_be_bytes());
    let info = head_off + 0x20;
    out[info] = 1; // PCM16BE
    out[info + 1] = 1; // loops
    out[info + 2] = 2; // channels
    out[info + 4..info + 6].copy_from_slice(&rate.to_be_bytes());
    out[info + 8..info + 12].copy_from_slice(&loop_start.to_be_bytes());
    out[info + 12..info + 16].copy_from_slice(&(frames.len() as u32).to_be_bytes());
    out[info + 16..info + 20].copy_from_slice(&(audio_off as u32).to_be_bytes());
    out[info + 20..info + 24].copy_from_slice(&(blocks as u32).to_be_bytes());
    out[info + 24..info + 28].copy_from_slice(&(BLOCK as u32).to_be_bytes());
    out[info + 40..info + 44].copy_from_slice(&(BLOCK as u32).to_be_bytes());
    out[data_off..data_off + 4].copy_from_slice(b"DATA");
    out[data_off + 4..data_off + 8].copy_from_slice(&((total - data_off) as u32).to_be_bytes());
    out.extend_from_slice(&data);
    out
}
