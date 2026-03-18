Glitch Shifter Web
A high-performance, real-time audio effect processor built with the Web Audio API and AudioWorklets. This project serves as a web-based simulator and algorithm testbed for the DSP implementation currently being developed for an embedded version based on the ESP32 S3.

🌐 Live Demo
Try the simulator directly in your browser:
https://ovelhaaa.github.io/Glitch-shifter-web/

🚀 Overview
Glitch Shifter Web is designed for experimental sound design and real-time audio manipulation. It allows for rapid prototyping and fine-tuning of audio algorithms before deploying them to embedded C++ environments like the ESP32 S3.

The engine utilizes AudioWorkletProcessor to ensure low-latency, glitch-free audio processing in a separate thread, mimicking the real-time constraints of hardware DSP.

✨ Key Features
1. Advanced Pitch Shifter
Dual-Grain Overlap-Add: Uses a 2-grain system with a "centered anchored geometry" to maintain stability.

Cubic Hermite Interpolation: Provides high-quality resampling with significantly fewer artifacts than linear interpolation.

Pitch Modulation: Integrated LFO for subtle vibrato or wild pitch FM.

Safety Buffer Management: Implements a "forbidden zone" logic to prevent grains from hitting the write head, avoiding metallic comb-filtering artifacts.

2. Musical Bitcrusher
Exponential Mapping: The control range is mapped exponentially, providing a more musical and easily controllable "crunch" effect.

Mix Control: Allows for parallel bitcrushing to preserve the original signal's transients.

3. Reverb with "Freeze" Mode
MonoFreeverb Core: Based on the classic Freeverb algorithm with optimized gain staging to prevent internal saturation.

Infinity Freeze: Captures the current reverb tail into an infinite loop with built-in gain normalization to prevent volume spikes.

Damping & Room Control: Fine-tune the space and texture of the reflections.

4. Safety & Dynamics
Soft Limiting: A global Math.tanh saturation stage provides a gentle "analog-style" clip before the hard limiter, protecting your ears and equipment.

🛠 Hardware Context
This project is the web companion to an embedded audio project powered by the ESP32 S3. By porting the core DSP classes from C++ to JavaScript, we can:

Test algorithm stability under different buffer conditions.

Visualize parameter response (like the exponential bitcrusher curve).

Verify gain staging and clipping behavior before burning the firmware.

🚦 Getting Started
Due to browser security policies regarding AudioWorklets, the project must be served via a web server.

Clone the repository:

Bash
git clone https://github.com/ovelhaaa/Glitch-shifter-web.git
cd glitch-shifter-web
Run a local server:
Using Python: python -m http.server 8000
Or using Node.js: npx serve .

Open in Browser: http://localhost:8000

📜 License
This project is licensed under the MIT License - see the LICENSE file for details.****
