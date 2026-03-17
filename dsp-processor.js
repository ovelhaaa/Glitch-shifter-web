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

// PitchShifter redesigned as a real-time safe dual-grain overlap-add pitch shifter.
// The old design used a hard switch/tap-swap that caused clicks because the
// crossfade was abrupt and the phases were not continuously windowed.
// This new design uses two grains, 180 degrees out of phase, with continuous
// Hann windowing to ensure smooth overlapping without discontinuities.
class PitchShifter {
    constructor() {
        this.buf = null;
        this.bufSize = 0;
        this.sr = 48000;
        this.writePos = 0;

        this.grainSizeSamples = 2048; // ~40ms at 48kHz
        this.baseDelaySamples = 2048; // Safe delay behind the writer

        // Two grains, phases in [0, 1)
        this.phaseA = 0.0;
        this.phaseB = 0.5; // 180 degrees out of phase

        this.rate = 1.0;
        this.active = false;
    }

    init(sampleRate, bufferSamples) {
        // Handle invalid sample rate or buffer size safely
        if (!sampleRate || sampleRate <= 0) sampleRate = 48000;
        if (!bufferSamples || bufferSamples <= 0) bufferSamples = 8192;

        this.sr = sampleRate;
        this.bufSize = bufferSamples;
        this.buf = new Float32Array(this.bufSize + 4);
        this.writePos = 0;

        // Setup grain geometry
        // Conservative default grain size: ~40ms
        this.grainSizeSamples = Math.floor(this.sr * 0.040);
        if (this.grainSizeSamples < 128) this.grainSizeSamples = 128;

        // Base delay safely behind writer
        let calculatedBaseDelay = Math.floor(this.sr * 0.050);
        this.baseDelaySamples = Math.max(this.grainSizeSamples, calculatedBaseDelay);

        // Reset phases
        this.phaseA = 0.0;
        this.phaseB = 0.5;

        this.active = true;
        return true;
    }

    setTransposition(semitones) {
        // Clamp pitch shift range to a practical range, e.g., [-12, +12]
        if (semitones < -12.0) semitones = -12.0;
        if (semitones > 12.0) semitones = 12.0;
        this.rate = Math.pow(2.0, semitones / 12.0);
    }

    wrapIndex(pos) {
        return ((pos % this.bufSize) + this.bufSize) % this.bufSize;
    }

    readInterpolated(pos) {
        let idx = Math.floor(pos);
        let frac = pos - idx;
        let i1 = this.wrapIndex(idx);
        let i2 = this.wrapIndex(idx + 1);
        let s1 = this.buf[i1];
        let s2 = this.buf[i2];
        return s1 + frac * (s2 - s1);
    }

    // Calculates the window amplitude for a given phase in [0, 1) using a Hann window
    getWindow(phase) {
        return 0.5 - 0.5 * Math.cos(2.0 * Math.PI * phase);
    }

    process(inp) {
        if (!this.active || !this.buf) return inp;

        // Write the input sample
        this.buf[this.writePos] = inp;
        let currentWritePos = this.writePos;

        if (++this.writePos >= this.bufSize) this.writePos = 0;

        // Phase increment tied to grain duration
        let phaseInc = 1.0 / this.grainSizeSamples;

        // Grain travel based on rate
        // rate = 1.0 -> no shift, travel equals 0 (read head moves at exactly write speed)
        // rate > 1.0 -> higher pitch, read head travels forward relative to write head
        // rate < 1.0 -> lower pitch, read head travels backward relative to write head
        let rateTravel = this.rate - 1.0;

        // Calculate read position for Grain A
        let grainTravelA = this.phaseA * this.grainSizeSamples * rateTravel;
        let readPosA = this.wrapIndex(currentWritePos - this.baseDelaySamples + grainTravelA);
        let outA = this.readInterpolated(readPosA);
        let winA = this.getWindow(this.phaseA);

        // Calculate read position for Grain B
        let grainTravelB = this.phaseB * this.grainSizeSamples * rateTravel;
        let readPosB = this.wrapIndex(currentWritePos - this.baseDelaySamples + grainTravelB);
        let outB = this.readInterpolated(readPosB);
        let winB = this.getWindow(this.phaseB);

        let out = outA * winA + outB * winB;

        // Advance phases
        this.phaseA += phaseInc;
        this.phaseB += phaseInc;

        // Respawn grains silently when phase wraps
        if (this.phaseA >= 1.0) this.phaseA -= 1.0;
        if (this.phaseB >= 1.0) this.phaseB -= 1.0;

        return out;
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
        this.damp = d;
        for (let i = 0; i < 8; i++) this.comb[i].setDamp(d);
    }
    setWet(w) {
        this.wet = w;
        this.dry = 1.0 - w;
    }
    setWidth(w) { this.width = w; }
    setSampleRate(sr) { this.sampleRate = sr; }

    setFreeze(f) {
        if (f && !this.freeze) {
            // Use safer near-unity value instead of 1.0 to prevent infinite build-up
            for (let i = 0; i < 8; i++) this.comb[i].setFeedback(0.9999);
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
 * 1. Pitch Shifter: The old shifter clicked because it abruptly swapped between
 *    read heads without continuously windowing the crossfade, causing discontinuities.
 *    The new design uses a dual-grain overlap-add strategy. Grains are spaced 180
 *    degrees out of phase, Hann-windowed, and respawned safely behind the writer
 *    when their phase wraps. This prevents clicks at the cost of slight latency
 *    and some typical graininess for granular shifts.
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
                        case 'pitch_semitones': this.shifter.setTransposition(Math.round(val)); break;
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
            this.shifter.setTransposition(Math.round(this.params.pitch_semitones));

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
