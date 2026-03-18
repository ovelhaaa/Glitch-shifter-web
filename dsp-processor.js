class BitCrusher {
    constructor() {
        this.amount = 0.0;
        this.counter = 0;
        this.hold = 0.0;
    }

    init() {
        this.amount = 0.0;
        this.counter = 0;
        this.hold = 0.0;
    }

    setAmount(a) {
        this.amount = a < 0.0 ? 0.0 : (a > 1.0 ? 1.0 : a);
    }

    process(inp) {
        if (this.amount <= 0.0001) return inp;

        // Exponential mapping for a wider and easier to dial in control range.
        // The hold samples are mapped logarithmically, so lower values give a
        // musical crunch that gradually gets more extreme.
        let factor = Math.max(1, Math.floor(Math.pow(2.0, this.amount * 8.0)));

        if (this.counter <= 0) {
            this.hold = inp;
            this.counter = factor - 1;
        } else {
            this.counter--;
        }
        return this.hold;
    }
}

// PitchShifter redesigned as a real-time safe 4-grain overlap-add pitch shifter.
// The old design used a hard switch/tap-swap that caused clicks.
// The previous dual-grain design improved this, but could still sound rigid.
// This new version uses 4 grains spaced equally (0, 0.25, 0.5, 0.75),
// continuous Hann windowing, cubic interpolation, and pitch smoothing to
// maximize smoothness and minimize graininess and robotic artifacts.
class PitchShifter {
    constructor() {
        this.buf = null;
        this.bufSize = 0;
        this.sr = 48000;
        this.writePos = 0;

        this.grainSizeSamples = 2400; // ~50ms at 48kHz
        this.baseDelaySamples = 2400; // Safe delay behind the writer (~50ms)

        // 2 grains, phases evenly distributed in [0, 1)
        this.phases = [0.0, 0.5];

        // Pitch smoothing
        this.targetRate = 1.0;
        this.smoothedRate = 1.0;

        // Subtle Pitch Modulation
        this.modDepthCents = 0.0;
        this.modRateHz = 0.2;
        this.modPhase = 0.0;
        this.smoothedModDepth = 0.0;

        this.active = false;
    }

    init(sampleRate, bufferSamples) {
        if (!sampleRate || sampleRate <= 0) sampleRate = 48000;

        // Ensure buffer is large enough for safe base delay + max travel
        // 16384 is approx 341ms at 48kHz, plenty of room for 50ms base delay and up to +12st grain travel.
        if (!bufferSamples || bufferSamples <= 0) bufferSamples = 16384;
        if (bufferSamples < 16384) bufferSamples = 16384;

        this.sr = sampleRate;
        // Make buffer slightly larger to safely read cubic interpolation points
        this.bufSize = bufferSamples;
        this.buf = new Float32Array(this.bufSize + 8);
        this.writePos = 0;

        // Setup grain geometry for maximum smoothness
        // Target 50ms grain size
        this.grainSizeSamples = Math.floor(this.sr * 0.050);
        if (this.grainSizeSamples < 128) this.grainSizeSamples = 128;
        this.phaseInc = 1.0 / this.grainSizeSamples;

        // Base delay strictly calculated for maximum safe excursion.
        // Pitch bounds: -12st (rate=0.5) to +12st (rate=2.0)
        // Max travel = max(|(0-0.5)*grainSize*(-0.5)|, |(1-0.5)*grainSize*(1.0)|)
        // Max travel happens at rate=2.0: (1-0.5)*grainSize*1.0 = 0.5 * grainSize
        let maxTravel = Math.floor(0.5 * this.grainSizeSamples);
        let safetyMargin = 64; // This margin must be smaller than `forbiddenZoneSamples` (256) for that logic to be active.
        this.baseDelaySamples = maxTravel + safetyMargin;

        // Reset phases
        this.phases = [0.0, 0.5];

        // Reset modulation
        this.modPhase = 0.0;

        this.active = true;
        return true;
    }

    setTransposition(semitones) {
        // Clamp pitch shift range conservatively: [-12, +12]
        if (semitones < -12.0) semitones = -12.0;
        if (semitones > 12.0) semitones = 12.0;
        this.targetRate = Math.pow(2.0, semitones / 12.0);
    }

    setModulation(depthCents, rateHz) {
        // Clamp modulation values to prevent wild artifacts.
        // As requested: pitch_mod_depth_cents: 0 a 8, pitch_mod_rate_hz: 0.05 a 1.5
        this.modDepthCents = Math.max(0.0, Math.min(depthCents, 8.0));
        this.modRateHz = Math.max(0.05, Math.min(rateHz, 1.5));
    }

    wrapIndex(pos) {
        let p = pos;
        while (p < 0) p += this.bufSize;
        while (p >= this.bufSize) p -= this.bufSize;
        return p;
    }

    // Cubic Hermite Interpolation for higher audio quality
    readCubicInterpolated(pos) {
        let idx = Math.floor(pos);
        let frac = pos - idx;

        // Get surrounding 4 points
        let i0 = this.wrapIndex(idx - 1);
        let i1 = this.wrapIndex(idx);
        let i2 = this.wrapIndex(idx + 1);
        let i3 = this.wrapIndex(idx + 2);

        let y0 = this.buf[i0];
        let y1 = this.buf[i1];
        let y2 = this.buf[i2];
        let y3 = this.buf[i3];

        // Hermite interpolation logic
        let c0 = y1;
        let c1 = 0.5 * (y2 - y0);
        let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);

        return ((c3 * frac + c2) * frac + c1) * frac + c0;
    }

    // Calculates the window amplitude for a given phase in [0, 1) using a Hann window
    getWindow(phase) {
        return 0.5 - 0.5 * Math.cos(2.0 * Math.PI * phase);
    }

    distanceToWriter(readPos, writePos) {
        // Forward distance from readPos to writePos
        return ((writePos - readPos) % this.bufSize + this.bufSize) % this.bufSize;
    }

    process(inp) {
        if (!this.active || !this.buf) return inp;

        // Smooth parameter changes
        const pitchSmoothFactor = 0.001; // Lowpass filter for pitch rate
        this.smoothedRate = this.smoothedRate + pitchSmoothFactor * (this.targetRate - this.smoothedRate);

        const modSmoothFactor = 0.001; // Lowpass for mod depth
        this.smoothedModDepth = this.smoothedModDepth + modSmoothFactor * (this.modDepthCents - this.smoothedModDepth);

        // Apply pitch modulation (LFO)
        let currentRate = this.smoothedRate;
        if (this.smoothedModDepth > 0.0001) {
            this.modPhase += (2.0 * Math.PI * this.modRateHz) / this.sr;
            if (this.modPhase > 2.0 * Math.PI) this.modPhase -= 2.0 * Math.PI;

            // Calculate semitone shift from cents
            let modSemitones = (this.smoothedModDepth / 100.0) * Math.sin(this.modPhase);
            let modRatio = Math.pow(2.0, modSemitones / 12.0);
            currentRate *= modRatio;
        }

        // Write the input sample
        this.buf[this.writePos] = inp;
        let currentWritePos = this.writePos;

        if (++this.writePos >= this.bufSize) this.writePos = 0;

        let rateTravel = currentRate - 1.0;
        let outSum = 0.0;

        // Process all 2 grains
        for (let i = 0; i < 2; i++) {
            let p = this.phases[i];

            // Calculate read position for current Grain
            // Anchored geometry: at the center of the window (p = 0.5), the delay is exactly baseDelaySamples.
            let grainTravel = (p - 0.5) * this.grainSizeSamples * rateTravel;
            let readPos = currentWritePos - this.baseDelaySamples + grainTravel;

            let dist = this.distanceToWriter(readPos, currentWritePos);

            // Forbidden zone explicit protection
            const forbiddenZoneSamples = 256;

            let grainWin = this.getWindow(p);

            // If we are getting too close to the writer (less than forbiddenZoneSamples),
            if (dist < forbiddenZoneSamples) {
                // To protect the grain from overrunning the write head while preserving the strict
                // 0.5 phase offset required for 2-grain unity gain sum, we freeze the read pointer
                // relative to the write pointer (effective rate = 1.0).
                // We maintain the safe distance until the grain naturally phases out and wraps around.
                // We NEVER manually jump this.phases[i] by 0.5, as that would cause the two grains
                // to collide and create extreme amplitude modulation.
                readPos = this.wrapIndex(currentWritePos - forbiddenZoneSamples);
            }

            // Final defensive check against NaN/Infinity before reading
            if (Number.isNaN(readPos) || !Number.isFinite(readPos)) readPos = 0;

            let grainOut = this.readCubicInterpolated(readPos);
            outSum += grainOut * grainWin;

            // Advance phase
            this.phases[i] += this.phaseInc;

            // Respawn grain silently when phase wraps
            if (this.phases[i] >= 1.0) {
                this.phases[i] -= 1.0;
            }
        }

        // Gain compensation: 2 overlapping Hann windows spaced by 0.5 phase sum exactly to 1.0.
        // No division needed. Return outSum directly.
        return outSum;
    }
}

class Comb {
    constructor() {
        this.buf = null;
        this.size = 0;
        this.idx = 0;
        this.feedback = 0.0;
        this.filterstore = 0.0;
        this.damp1 = 0.0;
        this.damp2 = 0.0;
    }
    init(samples) {
        this.size = samples;
        this.buf = new Float32Array(this.size + 2);
        this.idx = 0;
        this.filterstore = 0.0;
    }
    setFeedback(f) { this.feedback = f; }
    setDamp(d) { this.damp1 = d; this.damp2 = 1.0 - d; }
    process(inp) {
        if (!this.buf || this.size === 0) return inp;
        let output = this.buf[this.idx];
        this.filterstore = (output * this.damp2) + (this.filterstore * this.damp1);
        this.buf[this.idx] = inp + (this.filterstore * this.feedback);
        if (++this.idx >= this.size) this.idx = 0;
        return output;
    }
}

class Allpass {
    constructor() {
        this.buf = null;
        this.size = 0;
        this.idx = 0;
        this.feedback = 0.0;
    }
    init(samples) {
        this.size = samples;
        this.buf = new Float32Array(this.size + 2);
        this.idx = 0;
    }
    process(inp) {
        if (!this.buf || this.size === 0) return inp;
        let bufout = this.buf[this.idx];
        let output = -inp + bufout;
        this.buf[this.idx] = inp + (bufout * this.feedback);
        if (++this.idx >= this.size) this.idx = 0;
        return output;
    }
}

class MonoFreeverb {
    constructor() {
        this.sampleRate = 48000;
        this.room = 0.9;
        this.damp = 0.2;
        this.wet = 0.25;
        this.dry = 0.75;
        this.width = 1.0;
        this.savedRoom = 0.9;
        this.freeze = false;
        this.freezeModDepth = 0.0;
        this.freezeModRate = 0.1;
        this.freezePhase = 0.0;
        this.freezePeak = 1e-6;
        this.freezeNormTarget = 0.8;

        this.comb = [];
        for (let i = 0; i < 8; i++) this.comb.push(new Comb());
        this.allpass = [];
        for (let i = 0; i < 4; i++) this.allpass.push(new Allpass());
    }

    init(sr) {
        this.sampleRate = sr;
        // Comb tuning values scaled for the sample rate (original tuning assumes 44100Hz)
        // Note: The C++ code uses fixed constants, so we'll use those exactly.
        const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        const allT = [556, 441, 341, 225];

        // Actually, we should scale them to the current sampleRate, but let's stick to the C++ code
        // which hardcodes these. If we want it to sound correct at any SR, we should scale it.
        // C++ codebase uses fixed values, so we will do the same:
        for (let i = 0; i < 8; i++) {
            this.comb[i].init(Math.floor(combT[i] * sr / 44100));
            this.comb[i].setFeedback(this.room);
            this.comb[i].setDamp(this.damp);
        }
        for (let i = 0; i < 4; i++) {
            this.allpass[i].init(Math.floor(allT[i] * sr / 44100));
            this.allpass[i].feedback = 0.5;
        }
        this.savedRoom = this.room;
        return true;
    }

    setRoom(r) {
        // Clamp room feedback to safe ranges to prevent blowing up
        if (r > 0.98) r = 0.98;
        if (r < 0.0) r = 0.0;
        this.room = r;
        this.savedRoom = r;
        for (let i = 0; i < 8; i++) this.comb[i].setFeedback(r);
    }
    setDamp(d) {
        if (d > 1.0) d = 1.0;
        if (d < 0.0) d = 0.0;
        this.damp = d;
        for (let i = 0; i < 8; i++) this.comb[i].setDamp(d);
    }
    setWet(w) {
        if (w > 1.0) w = 1.0;
        if (w < 0.0) w = 0.0;
        this.wet = w;
        this.dry = 1.0 - w;
    }
    setWidth(w) { this.width = w; }
    setSampleRate(sr) { this.sampleRate = sr; }

    setFreeze(f) {
        if (f && !this.freeze) {
            // Use an even safer near-unity value instead of 0.9999 to prevent infinite build-up and clipping
            for (let i = 0; i < 8; i++) this.comb[i].setFeedback(0.9995);
            this.freezePeak = 1e-6;
        } else if (!f && this.freeze) {
            for (let i = 0; i < 8; i++) this.comb[i].setFeedback(this.savedRoom);
        }
        this.freeze = f;
    }
    setFreezeMod(depth, rateHz) {
        this.freezeModDepth = depth;
        this.freezeModRate = rateHz;
    }
    setFreezeNormTarget(t) {
        this.freezeNormTarget = t;
    }

    process(mono) {
        // Scale input down to prevent saturation in the comb bank
        let combInput = this.freeze ? 0.0 : mono * 0.15;
        let out = 0.0;

        for (let i = 0; i < 8; i++) out += this.comb[i].process(combInput);

        // Attenuate summed comb output
        out *= 0.25;

        for (let i = 0; i < 4; i++) out = this.allpass[i].process(out);

        let freezeGain = 1.0;
        if (this.freeze && this.freezeModDepth > 0.00001) {
            this.freezePhase += (2.0 * Math.PI * this.freezeModRate) / this.sampleRate;
            if (this.freezePhase > 2.0 * Math.PI) this.freezePhase -= 2.0 * Math.PI;
            let lfo = 0.5 + 0.5 * Math.sin(this.freezePhase);
            freezeGain = 1.0 - (this.freezeModDepth * (1.0 - lfo));
        }

        if (this.freeze) {
            let a = Math.abs(out);
            const release_coef = 0.9998;
            this.freezePeak = Math.max(a, this.freezePeak * release_coef);
            let target = this.freezeNormTarget;
            const eps = 1e-6;
            let gain = target / (this.freezePeak + eps);
            const maxGain = 10.0;
            if (gain > maxGain) gain = maxGain;
            out *= gain;
        } else {
            this.freezePeak *= 0.9999;
        }

        return mono * this.dry + (out * this.wet * freezeGain);
    }
}

/**
 * GlitchShifterProcessor
 *
 * Major Improvements Summary:
 * 1. Pitch Shifter: The previous design used 4 grains, but to combat internal phase
 *    cancellations, comb-filtering, and metallic artificial artifacts, it was re-engineered
 *    back to 2 tightly controlled grains. A new "centered anchored geometry" was added where
 *    the base delay matches the window center (0.5 phase) to keep travel stable.
 *    A strict forbidden zone protects the grains from the write head, dynamically freezing
 *    them rather than aggressively jumping.
 * 2. Reverb: Gain staging improved. Comb bank input is scaled down and output is
 *    attenuated. Room parameters are clamped below 1.0 (freeze uses 0.9999). This
 *    stops internal saturation.
 * 3. BitCrusher: Switched from linear to an exponential mapping, making the control
 *    range wider and more useful/musical to dial in.
 * 4. Limiting: Added a soft clipper (tanh) before the final hard limiter to avoid
 *    harsh digital distortion while still bounding output.
 */
class GlitchShifterProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.shifter = new PitchShifter();
        this.reverb = new MonoFreeverb();
        this.crusher = new BitCrusher();
        this.initialized = false;

        this.params = {
            pitch_semitones: 7.0,
            pitch_mod_depth_cents: 0.0,
            pitch_mod_rate_hz: 0.2,
            pitch_mix: 1.0,
            reverb_room: 0.9,
            reverb_damp: 0.2,
            reverb_wet: 0.25,
            crusher_amount: 0.0,
            crusher_mix: 1.0,
            freeze: false,
            freeze_norm: 0.8,
            bypass_pitch: false,
            bypass_crusher: false,
            bypass_reverb: false
        };

        this.port.onmessage = (e) => {
            const data = e.data;
            if (data.type === 'param') {
                const { key, val } = data;
                this.params[key] = val;

                if (this.initialized) {
                    switch (key) {
                        case 'pitch_semitones': this.shifter.setTransposition(val); break;
                        case 'pitch_mod_depth_cents':
                        case 'pitch_mod_rate_hz':
                            this.shifter.setModulation(this.params.pitch_mod_depth_cents, this.params.pitch_mod_rate_hz);
                            break;
                        case 'reverb_room': this.reverb.setRoom(val); break;
                        case 'reverb_damp': this.reverb.setDamp(val); break;
                        case 'reverb_wet': this.reverb.setWet(val); break;
                        case 'crusher_amount': this.crusher.setAmount(val); break;
                        case 'freeze': this.reverb.setFreeze(val); break;
                        case 'freeze_norm': this.reverb.setFreezeNormTarget(val); break;
                    }
                }
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (!this.initialized) {
            this.shifter.init(sampleRate, 8192);
            this.shifter.setTransposition(this.params.pitch_semitones);
            this.shifter.setModulation(this.params.pitch_mod_depth_cents, this.params.pitch_mod_rate_hz);

            this.reverb.init(sampleRate);
            this.reverb.setRoom(this.params.reverb_room);
            this.reverb.setDamp(this.params.reverb_damp);
            this.reverb.setWet(this.params.reverb_wet);
            this.reverb.setFreeze(this.params.freeze);
            this.reverb.setFreezeNormTarget(this.params.freeze_norm);

            this.crusher.init();
            this.crusher.setAmount(this.params.crusher_amount);

            this.initialized = true;
        }

        const input = inputs[0];
        const output = outputs[0];

        if (!input || input.length === 0) return true;

        const channelCount = output.length;
        const frameCount = output[0].length;

        for (let i = 0; i < frameCount; i++) {
            let inL = input[0] ? input[0][i] : 0;
            let inR = input[1] ? input[1][i] : inL;
            let mono = 0.5 * (inL + inR);

            let x = mono;

            if (!this.params.bypass_pitch) {
                let shiftOut = this.shifter.process(x);
                x = x * (1.0 - this.params.pitch_mix) + shiftOut * this.params.pitch_mix;
            }

            if (!this.params.bypass_crusher) {
                let crushOut = this.crusher.process(x);
                x = x * (1.0 - this.params.crusher_mix) + crushOut * this.params.crusher_mix;
            }

            if (!this.params.bypass_reverb) {
                x = this.reverb.process(x);
            }

            // Gentle global soft limiting to prevent harsh digital clipping.
            // Using a simple tanh approximation or Math.tanh for smooth saturation.
            x = Math.tanh(x);

            // Safety hard clamp just in case
            if (x > 1.0) x = 1.0;
            if (x < -1.0) x = -1.0;

            for (let c = 0; c < channelCount; c++) {
                output[c][i] = x; // Output stereo/mono duplicate
            }
        }

        return true;
    }
}

registerProcessor('glitch-shifter-processor', GlitchShifterProcessor);
