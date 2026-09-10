import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Mic,
  MicOff,
  Radio,
  Send,
  Volume2,
} from 'lucide-react';

const APP_VERSION = '1.1.0-preamble-diagnostics';

const AUDIO_CONFIG = {
  dataTones: [1200, 1700, 2200, 2700],
  // Новый preamble использует частоты, которые Fold уже уверенно распознал.
  startMarker: [2700, 1700, 1200, 2700, 1700, 1200],
  markerToneDuration: 0.05,
  markerGapDuration: 0.024,
  toneDuration: 0.024,
  gapDuration: 0.012,
  leadSilence: 0.1,
  tailSilence: 0.08,
  amplitude: 0.72,
  maxPayloadBytes: 256,
  selfTestTimeoutMs: 3000,
};

const RECEIVER_WORKLET = `
class FskReceiverProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frequencies = [1200, 1700, 2200, 2700];
    this.noiseFloor = 0.0015;
    this.thresholdFactor = 3.7;
    this.segment = [];
    this.active = false;
    this.silenceBlocks = 0;
    this.blockCounter = 0;
    this.minToneSamples = Math.floor(sampleRate * 0.01);
    // 80 ms оставляет запас для длинного preamble и комнатного хвоста.
    this.maxToneSamples = Math.floor(sampleRate * 0.08);

    this.port.onmessage = (event) => {
      if (event.data?.type === 'sensitivity') {
        const value = Math.max(1, Math.min(5, Number(event.data.value) || 3));
        this.thresholdFactor = 5.0 - (value - 1) * 0.65;
      }
    };
  }

  goertzel(samples, frequency) {
    const omega = 2 * Math.PI * frequency / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let q0 = 0;
    let q1 = 0;
    let q2 = 0;
    const n = samples.length;

    for (let i = 0; i < n; i++) {
      const window = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
      q0 = samples[i] * window + coeff * q1 - q2;
      q2 = q1;
      q1 = q0;
    }

    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
  }

  classifySegment() {
    if (this.segment.length < this.minToneSamples) {
      this.segment = [];
      return;
    }

    const energies = this.frequencies.map((frequency) => ({
      frequency,
      energy: this.goertzel(this.segment, frequency),
    }));

    energies.sort((a, b) => b.energy - a.energy);
    const best = energies[0];
    const second = energies[1];
    const confidence = best.energy / Math.max(second.energy, 1e-12);

    if (confidence >= 1.3) {
      this.port.postMessage({
        type: 'tone',
        frequency: best.frequency,
        confidence,
      });
    }

    this.segment = [];
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    const rms = Math.sqrt(sum / input.length);
    const threshold = Math.max(0.0025, this.noiseFloor * this.thresholdFactor);
    const isTone = rms > threshold;

    if (isTone) {
      this.active = true;
      this.silenceBlocks = 0;
      for (let i = 0; i < input.length; i++) {
        if (this.segment.length < this.maxToneSamples) {
          this.segment.push(input[i]);
        }
      }
    } else {
      if (!this.active) {
        this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
      } else {
        this.silenceBlocks += 1;
        if (this.silenceBlocks >= 2) {
          this.classifySegment();
          this.active = false;
          this.silenceBlocks = 0;
        }
      }
    }

    this.blockCounter += 1;
    if (this.blockCounter % 8 === 0) {
      this.port.postMessage({
        type: 'meter',
        rms,
        noiseFloor: this.noiseFloor,
        threshold,
      });
    }

    return true;
  }
}

registerProcessor('fsk-receiver', FskReceiverProcessor);
`;

function crc16Ccitt(bytes) {
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000)
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }

  return crc;
}

function bytesToSymbols(bytes) {
  const symbols = [];

  for (const byte of bytes) {
    symbols.push(
      (byte >> 6) & 0b11,
      (byte >> 4) & 0b11,
      (byte >> 2) & 0b11,
      byte & 0b11,
    );
  }

  return symbols;
}

function createFrame(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const payload = new TextEncoder().encode(json);

  if (payload.length > AUDIO_CONFIG.maxPayloadBytes) {
    throw new Error(`Пакет слишком большой: ${payload.length} байт. Максимум ${AUDIO_CONFIG.maxPayloadBytes}.`);
  }

  // CRC защищает и поле длины, и payload.
  const protectedBytes = new Uint8Array(2 + payload.length);
  protectedBytes[0] = (payload.length >> 8) & 0xff;
  protectedBytes[1] = payload.length & 0xff;
  protectedBytes.set(payload, 2);

  const crc = crc16Ccitt(protectedBytes);
  const frame = new Uint8Array(protectedBytes.length + 2);
  frame.set(protectedBytes, 0);
  frame[frame.length - 2] = (crc >> 8) & 0xff;
  frame[frame.length - 1] = crc & 0xff;

  return frame;
}

function makeAudioBuffer(ctx, payloadObj) {
  const frame = createFrame(payloadObj);
  const symbols = bytesToSymbols(frame);
  const dataFrequencies = symbols.map((symbol) => AUDIO_CONFIG.dataTones[symbol]);

  const sampleRate = ctx.sampleRate;
  const markerToneSamples = Math.round(sampleRate * AUDIO_CONFIG.markerToneDuration);
  const markerGapSamples = Math.round(sampleRate * AUDIO_CONFIG.markerGapDuration);
  const dataToneSamples = Math.round(sampleRate * AUDIO_CONFIG.toneDuration);
  const dataGapSamples = Math.round(sampleRate * AUDIO_CONFIG.gapDuration);
  const leadSamples = Math.round(sampleRate * AUDIO_CONFIG.leadSilence);
  const tailSamples = Math.round(sampleRate * AUDIO_CONFIG.tailSilence);
  const fadeSamples = Math.max(1, Math.round(sampleRate * 0.002));

  const totalSamples =
    leadSamples +
    AUDIO_CONFIG.startMarker.length * (markerToneSamples + markerGapSamples) +
    dataFrequencies.length * (dataToneSamples + dataGapSamples) +
    tailSamples;

  const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
  const data = buffer.getChannelData(0);
  let offset = leadSamples;

  const writeTone = (frequency, toneSamples, gapSamples) => {
    for (let i = 0; i < toneSamples; i++) {
      const attack = Math.min(1, i / fadeSamples);
      const release = Math.min(1, (toneSamples - 1 - i) / fadeSamples);
      const envelope = Math.max(0, Math.min(attack, release));
      data[offset + i] =
        Math.sin((2 * Math.PI * frequency * i) / sampleRate) *
        AUDIO_CONFIG.amplitude *
        envelope;
    }
    offset += toneSamples + gapSamples;
  };

  for (const frequency of AUDIO_CONFIG.startMarker) {
    writeTone(frequency, markerToneSamples, markerGapSamples);
  }

  for (const frequency of dataFrequencies) {
    writeTone(frequency, dataToneSamples, dataGapSamples);
  }

  return buffer;
}

function nowTime() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SELF_TEST_STEPS = [
  ['microphone', 'Микрофон открыт'],
  ['worklet', 'AudioWorklet запущен'],
  ['tx', 'TX воспроизведён'],
  ['signal', 'Акустический сигнал услышан'],
  ['tone', 'FSK-тон распознан'],
  ['marker', 'Стартовый маркер найден'],
  ['length', 'Длина кадра прочитана'],
  ['crc', 'CRC16 совпал'],
  ['json', 'Payload декодирован'],
];

function makeSelfTestState(status = 'idle') {
  return {
    status,
    reason: '',
    steps: Object.fromEntries(
      SELF_TEST_STEPS.map(([key]) => [key, { status: 'pending', detail: '' }]),
    ),
  };
}

function payloadByteLength(payloadObj) {
  return new TextEncoder().encode(JSON.stringify(payloadObj)).length;
}

export default function App() {
  const [profile] = useState({
    name: 'Магос-Исследователь Сегментума',
    mechanicRank: 'Магос Билогис',
  });

  const [messages, setMessages] = useState([
    {
      id: crypto.randomUUID(),
      sender: 'Машинный Дух',
      text: 'Акустический модем готов. Включите RX или отправьте сообщение для self-test.',
      time: nowTime(),
      kind: 'system',
    },
  ]);

  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isBeaconActive, setIsBeaconActive] = useState(false);
  const [rxStatus, setRxStatus] = useState('RX выключен');
  const [txStatus, setTxStatus] = useState('TX свободен');
  const [lastTone, setLastTone] = useState(null);
  const [signalLevel, setSignalLevel] = useState(0);
  const [rxSensitivity, setRxSensitivity] = useState(2);
  const [lastError, setLastError] = useState('');
  const [micSettings, setMicSettings] = useState(null);
  const [discoveredPings, setDiscoveredPings] = useState([]);
  const [recentTones, setRecentTones] = useState([]);
  const [markerProgressView, setMarkerProgressView] = useState(0);
  const [selfTest, setSelfTest] = useState(() => makeSelfTestState());

  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const analyserRef = useRef(null);
  const receiverNodeRef = useRef(null);
  const muteGainRef = useRef(null);
  const animationFrameRef = useRef(null);
  const canvasRef = useRef(null);
  const workletLoadedRef = useRef(false);
  const beaconIntervalRef = useRef(null);
  const txQueueRef = useRef(Promise.resolve());
  const txQueueDepthRef = useRef(0);

  const markerProgressRef = useRef(0);
  const receivingRef = useRef(false);
  const symbolBufferRef = useRef([]);
  const frameBytesRef = useRef([]);
  const expectedFrameBytesRef = useRef(null);
  const selfTestActiveRef = useRef(false);
  const selfTestIdRef = useRef(null);
  const selfTestTimeoutRef = useRef(null);
  const selfTestTxStartedRef = useRef(false);

  async function ensureAudioContext() {
    if (!audioCtxRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Web Audio API не поддерживается этим браузером.');
      }
      audioCtxRef.current = new AudioContextClass();
    }

    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }

    return audioCtxRef.current;
  }

  async function loadReceiverWorklet(ctx) {
    if (workletLoadedRef.current) return;
    if (!ctx.audioWorklet) {
      throw new Error('AudioWorklet не поддерживается этим браузером.');
    }

    const blob = new Blob([RECEIVER_WORKLET], {
      type: 'application/javascript',
    });
    const url = URL.createObjectURL(blob);

    try {
      await ctx.audioWorklet.addModule(url);
      workletLoadedRef.current = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function resetFrameReceiver(status = 'Ожидание маркера') {
    markerProgressRef.current = 0;
    setMarkerProgressView(0);
    receivingRef.current = false;
    symbolBufferRef.current = [];
    frameBytesRef.current = [];
    expectedFrameBytesRef.current = null;
    setRxStatus(status);
  }

  function markSelfTestStep(key, detail = '') {
    if (!selfTestActiveRef.current) return;

    setSelfTest((prev) => {
      if (prev.steps[key]?.status === 'pass') return prev;
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [key]: { status: 'pass', detail },
        },
      };
    });
  }

  function clearSelfTestTimer() {
    if (selfTestTimeoutRef.current) {
      clearTimeout(selfTestTimeoutRef.current);
      selfTestTimeoutRef.current = null;
    }
  }

  function failSelfTest(reason, failedStep = null) {
    if (!selfTestActiveRef.current) return;

    selfTestActiveRef.current = false;
    selfTestTxStartedRef.current = false;
    clearSelfTestTimer();

    setSelfTest((prev) => {
      const steps = { ...prev.steps };
      if (failedStep && steps[failedStep]?.status !== 'pass') {
        steps[failedStep] = { status: 'fail', detail: reason };
      }
      return { ...prev, status: 'fail', reason, steps };
    });
  }

  function passSelfTest() {
    if (!selfTestActiveRef.current) return;

    selfTestActiveRef.current = false;
    selfTestTxStartedRef.current = false;
    clearSelfTestTimer();
    setSelfTest((prev) => ({
      ...prev,
      status: 'pass',
      reason: 'Полный акустический loopback принят и проверен.',
      // Если RX завершился на несколько миллисекунд раньше source.onended,
      // PASS всё равно означает, что вся цепочка реально прошла успешно.
      steps: Object.fromEntries(
        SELF_TEST_STEPS.map(([key]) => [
          key,
          prev.steps[key]?.status === 'pass'
            ? prev.steps[key]
            : { status: 'pass', detail: prev.steps[key]?.detail || '' },
        ]),
      ),
    }));
  }

  function scheduleSelfTestTimeout() {
    clearSelfTestTimer();
    selfTestTimeoutRef.current = setTimeout(() => {
      failSelfTest('RX не завершил self-test в течение 3 секунд после окончания TX.');
    }, AUDIO_CONFIG.selfTestTimeoutMs);
  }

  function handleDecodedPayload(payload) {
    if (!payload || payload.v !== 1 || typeof payload.t !== 'string') {
      setRxStatus('RX: пакет неизвестной версии');
      failSelfTest('Неизвестная версия или тип payload.', 'json');
      return;
    }

    if (payload.t === 'selftest') {
      if (selfTestActiveRef.current && payload.id === selfTestIdRef.current) {
        setRxStatus('RX: SELF-TEST принят, CRC OK');
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sender: 'Система',
            text: '✅ SELF-TEST PASS: пакет прошёл через динамик → микрофон → FSK → CRC → JSON.',
            time: nowTime(),
            kind: 'system',
          },
        ]);
        passSelfTest();
      }
      return;
    }

    if (payload.t === 'message') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sender: payload.sender || 'Неизвестный передатчик',
          text: `📥 [RX настоящий]: ${payload.text ?? ''}`,
          time: nowTime(),
          kind: 'incoming',
        },
      ]);
      setRxStatus('RX: сообщение принято, CRC OK');
      return;
    }

    if (payload.t === 'profile') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sender: payload.name || 'Неизвестный профиль',
          text: `⚡ [RX профиль]: ${payload.rank || 'Без ранга'}`,
          time: nowTime(),
          kind: 'incoming',
        },
      ]);
      setRxStatus('RX: профиль принят, CRC OK');
      return;
    }

    if (payload.t === 'beacon') {
      const name = payload.name || 'Неизвестный маяк';
      setDiscoveredPings((prev) => {
        const withoutSame = prev.filter((item) => item.name !== name);
        return [
          { name, lastSeen: nowTime() },
          ...withoutSame,
        ].slice(0, 8);
      });
      setRxStatus(`RX: маяк ${name}`);
    }
  }

  function finalizeFrameIfReady() {
    const bytes = frameBytesRef.current;

    if (bytes.length >= 2 && expectedFrameBytesRef.current == null) {
      const payloadLength = (bytes[0] << 8) | bytes[1];

      if (payloadLength < 1 || payloadLength > AUDIO_CONFIG.maxPayloadBytes) {
        const reason = `RX: неверная длина ${payloadLength}`;
        resetFrameReceiver(reason);
        failSelfTest(reason, 'length');
        return;
      }

      expectedFrameBytesRef.current = 2 + payloadLength + 2;
      setRxStatus(`RX: пакет ${payloadLength} байт`);
      markSelfTestStep('length', `${payloadLength} байт`);
    }

    const expected = expectedFrameBytesRef.current;
    if (expected == null || bytes.length < expected) return;

    if (bytes.length > expected) {
      const reason = 'RX: переполнение кадра';
      resetFrameReceiver(reason);
      failSelfTest(reason, 'length');
      return;
    }

    const payloadLength = (bytes[0] << 8) | bytes[1];
    const payloadBytes = Uint8Array.from(bytes.slice(2, 2 + payloadLength));
    const receivedCrc =
      (bytes[2 + payloadLength] << 8) |
      bytes[3 + payloadLength];
    const protectedBytes = Uint8Array.from(bytes.slice(0, 2 + payloadLength));
    const calculatedCrc = crc16Ccitt(protectedBytes);

    if (receivedCrc !== calculatedCrc) {
      const reason = 'RX: CRC ERROR — пакет отброшен';
      resetFrameReceiver(reason);
      failSelfTest(reason, 'crc');
      return;
    }

    markSelfTestStep('crc', `0x${receivedCrc.toString(16).padStart(4, '0')}`);

    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
      const payload = JSON.parse(json);
      markSelfTestStep('json', payload.t || 'payload');
      handleDecodedPayload(payload);
    } catch (error) {
      setLastError(`RX decode: ${error.message}`);
      setRxStatus('RX: ошибка декодирования payload');
      failSelfTest(`RX decode: ${error.message}`, 'json');
    } finally {
      receivingRef.current = false;
      symbolBufferRef.current = [];
      frameBytesRef.current = [];
      expectedFrameBytesRef.current = null;
    }
  }

  function consumeDataTone(frequency) {
    const symbol = AUDIO_CONFIG.dataTones.indexOf(frequency);
    if (symbol === -1 || !receivingRef.current) return;

    symbolBufferRef.current.push(symbol);

    if (symbolBufferRef.current.length === 4) {
      const [a, b, c, d] = symbolBufferRef.current;
      const byte = (a << 6) | (b << 4) | (c << 2) | d;
      frameBytesRef.current.push(byte);
      symbolBufferRef.current = [];
      finalizeFrameIfReady();
    }
  }

  function consumeDetectedTone(frequency, confidence) {
    setLastTone({ frequency, confidence });
    setRecentTones((prev) => [
      ...prev,
      { frequency, confidence },
    ].slice(-18));

    if (selfTestActiveRef.current && selfTestTxStartedRef.current) {
      markSelfTestStep('tone', `${frequency} Hz`);
    }

    // После старта кадра эти же частоты являются данными, а не preamble.
    if (receivingRef.current) {
      consumeDataTone(frequency);
      return;
    }

    const marker = AUDIO_CONFIG.startMarker;
    const progress = markerProgressRef.current;

    if (frequency === marker[progress]) {
      markerProgressRef.current += 1;
      setMarkerProgressView(markerProgressRef.current);

      if (markerProgressRef.current === marker.length) {
        markerProgressRef.current = 0;
        setMarkerProgressView(0);
        receivingRef.current = true;
        symbolBufferRef.current = [];
        frameBytesRef.current = [];
        expectedFrameBytesRef.current = null;
        setRxStatus('RX: стартовый маркер найден');
        markSelfTestStep('marker', `${marker.length}/${marker.length}`);
      }
      return;
    }

    // Быстрый re-sync, если текущий тон может быть первым элементом marker.
    markerProgressRef.current = frequency === marker[0] ? 1 : 0;
    setMarkerProgressView(markerProgressRef.current);
  }

  function drawSpectrum(analyser) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx2d = canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const data = new Uint8Array(bufferLength);

    const draw = () => {
      if (analyserRef.current !== analyser) return;

      analyser.getByteFrequencyData(data);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.fillStyle = '#020617';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);

      const maxFrequency = 5000;
      const nyquist = audioCtxRef.current.sampleRate / 2;
      const maxBin = Math.min(
        bufferLength,
        Math.floor((maxFrequency / nyquist) * bufferLength),
      );
      const barWidth = canvas.width / Math.max(1, maxBin);

      for (let i = 0; i < maxBin; i++) {
        const height = (data[i] / 255) * canvas.height;
        ctx2d.fillStyle = `rgba(248, 113, 113, ${0.25 + (data[i] / 255) * 0.75})`;
        ctx2d.fillRect(
          i * barWidth,
          canvas.height - height,
          Math.max(1, barWidth),
          height,
        );
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
  }

  function stopListening() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    receiverNodeRef.current?.disconnect();
    micSourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    muteGainRef.current?.disconnect();

    receiverNodeRef.current = null;
    micSourceRef.current = null;
    analyserRef.current = null;
    muteGainRef.current = null;

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    resetFrameReceiver('RX выключен');
    setIsListening(false);
    setSignalLevel(0);
    setMicSettings(null);
  }

  async function startListening() {
    if (micStreamRef.current) return true;

    try {
      setLastError('');

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia недоступен. Откройте приложение через HTTPS или localhost.');
      }

      const ctx = await ensureAudioContext();
      await loadReceiverWorklet(ctx);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      const track = stream.getAudioTracks()[0];
      setMicSettings(track?.getSettings?.() ?? null);

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;

      const receiver = new AudioWorkletNode(ctx, 'fsk-receiver');
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;

      receiver.port.postMessage({
        type: 'sensitivity',
        value: rxSensitivity,
      });

      receiver.port.onmessage = (event) => {
        const data = event.data;

        if (data?.type === 'tone') {
          consumeDetectedTone(data.frequency, data.confidence);
        } else if (data?.type === 'meter') {
          setSignalLevel(data.rms || 0);
          if (
            selfTestActiveRef.current &&
            selfTestTxStartedRef.current &&
            Number(data.rms) > Number(data.threshold)
          ) {
            markSelfTestStep('signal', `RMS ${Number(data.rms).toFixed(4)}`);
          }
        }
      };

      source.connect(analyser);
      source.connect(receiver);
      receiver.connect(muteGain);
      muteGain.connect(ctx.destination);

      micStreamRef.current = stream;
      micSourceRef.current = source;
      analyserRef.current = analyser;
      receiverNodeRef.current = receiver;
      muteGainRef.current = muteGain;

      setIsListening(true);
      setRxStatus('RX: слушаю эфир');
      drawSpectrum(analyser);
      return true;
    } catch (error) {
      stopListening();
      setLastError(error.message);
      return false;
    }
  }

  async function toggleListening() {
    if (micStreamRef.current) {
      stopListening();
    } else {
      await startListening();
    }
  }

  async function transmitChirp(payload, label = 'пакет') {
    const ctx = await ensureAudioContext();
    const buffer = makeAudioBuffer(ctx, payload);

    setIsTransmitting(true);
    setTxStatus(`TX: ${label}`);

    try {
      await new Promise((resolve, reject) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = resolve;

        try {
          source.start();
        } catch (error) {
          reject(error);
        }
      });
    } finally {
      setIsTransmitting(false);
      setTxStatus('TX свободен');
    }
  }

  function enqueueTransmission(payload, label) {
    txQueueDepthRef.current += 1;

    const task = txQueueRef.current
      .catch(() => undefined)
      .then(() => transmitChirp(payload, label))
      .finally(() => {
        txQueueDepthRef.current = Math.max(0, txQueueDepthRef.current - 1);
      });

    txQueueRef.current = task;
    return task;
  }

  async function ensureSelfReceiveReady() {
    if (!micStreamRef.current) {
      const started = await startListening();
      if (!started) return false;
      await wait(200);
    }
    return true;
  }

  async function handleSendMessage(event) {
    event.preventDefault();
    const text = inputText.trim();
    if (!text) return;

    const candidatePayload = {
      v: 1,
      t: 'message',
      sender: profile.name,
      text,
    };
    if (payloadByteLength(candidatePayload) > AUDIO_CONFIG.maxPayloadBytes) {
      setLastError(`Сообщение не помещается в ${AUDIO_CONFIG.maxPayloadBytes} байт payload.`);
      return;
    }

    const rxReady = await ensureSelfReceiveReady();
    if (!rxReady) return;

    setInputText('');
    setLastError('');

    const payload = candidatePayload;

    try {
      await enqueueTransmission(payload, 'сообщение');
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sender: 'Я',
          text: `📤 [TX завершён]: ${text}`,
          time: nowTime(),
          kind: 'outgoing',
        },
      ]);
    } catch (error) {
      setLastError(`TX: ${error.message}`);
    }
  }

  async function handleProfileChirp() {
    const rxReady = await ensureSelfReceiveReady();
    if (!rxReady) return;

    try {
      await enqueueTransmission(
        {
          v: 1,
          t: 'profile',
          name: profile.name,
          rank: profile.mechanicRank,
        },
        'профиль',
      );
    } catch (error) {
      setLastError(`TX: ${error.message}`);
    }
  }

  function stopBeacon() {
    if (beaconIntervalRef.current) {
      clearInterval(beaconIntervalRef.current);
      beaconIntervalRef.current = null;
    }
    setIsBeaconActive(false);
  }

  function sendBeaconIfIdle() {
    if (txQueueDepthRef.current > 0) return;

    enqueueTransmission(
      {
        v: 1,
        t: 'beacon',
        name: profile.name,
      },
      'маяк',
    ).catch((error) => {
      setLastError(`Beacon TX: ${error.message}`);
    });
  }

  function toggleBeacon() {
    if (beaconIntervalRef.current) {
      stopBeacon();
      return;
    }

    setIsBeaconActive(true);
    sendBeaconIfIdle();
    beaconIntervalRef.current = setInterval(sendBeaconIfIdle, 30000);
  }

  async function runSelfTest() {
    if (txQueueDepthRef.current > 0 || isTransmitting) {
      setLastError('Дождитесь окончания текущей TX-передачи и запустите self-test ещё раз.');
      return;
    }

    clearSelfTestTimer();
    selfTestActiveRef.current = true;
    selfTestTxStartedRef.current = false;
    selfTestIdRef.current = Math.random().toString(36).slice(2, 8);
    setRecentTones([]);
    setSelfTest(makeSelfTestState('running'));
    setLastError('');

    const rxReady = await ensureSelfReceiveReady();
    if (!rxReady) {
      failSelfTest('Не удалось запустить микрофон/RX.', 'microphone');
      return;
    }

    markSelfTestStep('microphone', 'getUserMedia OK');
    if (receiverNodeRef.current) {
      markSelfTestStep('worklet', 'fsk-receiver active');
    } else {
      failSelfTest('AudioWorkletNode не создан.', 'worklet');
      return;
    }

    resetFrameReceiver('RX: self-test — ожидание preamble');
    // resetFrameReceiver сбрасывает только RX state, self-test остаётся активным.
    selfTestTxStartedRef.current = true;

    try {
      await enqueueTransmission(
        {
          v: 1,
          t: 'selftest',
          id: selfTestIdRef.current,
        },
        'self-test',
      );
      markSelfTestStep('tx', 'динамик завершил воспроизведение');
      if (selfTestActiveRef.current) {
        scheduleSelfTestTimeout();
      }
    } catch (error) {
      setLastError(`Self-test TX: ${error.message}`);
      failSelfTest(`TX error: ${error.message}`, 'tx');
    }
  }

  useEffect(() => {
    receiverNodeRef.current?.port.postMessage({
      type: 'sensitivity',
      value: rxSensitivity,
    });
  }, [rxSensitivity]);

  useEffect(() => {
    return () => {
      if (beaconIntervalRef.current) {
        clearInterval(beaconIntervalRef.current);
      }

      if (selfTestTimeoutRef.current) {
        clearTimeout(selfTestTimeoutRef.current);
      }

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      receiverNodeRef.current?.disconnect();
      micSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      muteGainRef.current?.disconnect();
      audioCtxRef.current?.close();
    };
  }, []);

  const echoCancellationOn = micSettings?.echoCancellation === true;
  const draftPayloadBytes = inputText.trim()
    ? payloadByteLength({
        v: 1,
        t: 'message',
        sender: profile.name,
        text: inputText.trim(),
      })
    : 0;
  const draftTooLarge = draftPayloadBytes > AUDIO_CONFIG.maxPayloadBytes;

  return (
    <div className="min-h-screen bg-slate-950 text-red-50 font-mono selection:bg-red-900 selection:text-white">
      <header className="border-b border-red-900/50 bg-slate-900/90 p-4">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-3 justify-between items-center">
          <div>
            <h1 className="font-bold text-red-400">
              LINGUA TECHNIS : ACOUSTIC MODEM
            </h1>
            <p className="text-[11px] text-slate-500 mt-1">
              4-FSK • реальный RX через микрофон • CRC16 • {APP_VERSION}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className={`px-2.5 py-1.5 rounded-lg ${isListening ? 'bg-emerald-950 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
              RX {isListening ? 'ON' : 'OFF'}
            </span>
            <span className={`px-2.5 py-1.5 rounded-lg ${isTransmitting ? 'bg-red-950 text-red-300' : 'bg-slate-800 text-slate-400'}`}>
              {txStatus}
            </span>
          </div>
        </div>
      </header>

      {lastError && (
        <div className="border-b border-amber-900/40 bg-amber-950/70 px-4 py-2 text-xs text-amber-200 flex gap-2 items-center justify-center">
          <AlertTriangle size={14} />
          {lastError}
        </div>
      )}

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
        <section className="flex flex-col gap-4">
          <div className="bg-slate-900/60 border border-red-900/40 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-red-400 mb-3">Профиль</h2>
            <p className="text-xs">{profile.name}</p>
            <p className="text-xs text-slate-400 mt-1">{profile.mechanicRank}</p>

            <button
              type="button"
              onClick={handleProfileChirp}
              className="mt-4 w-full min-h-11 px-3 py-2 bg-red-800 hover:bg-red-700 text-white rounded-xl text-xs flex items-center justify-center gap-2"
            >
              <Volume2 size={15} />
              Излучить профиль
            </button>
          </div>

          <div className="bg-slate-900/60 border border-red-900/40 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-red-400 mb-3">Маяк</h2>
            <button
              type="button"
              onClick={toggleBeacon}
              className={`w-full min-h-11 px-3 py-2 rounded-xl text-xs flex items-center justify-center gap-2 ${isBeaconActive ? 'bg-emerald-900 text-emerald-100' : 'bg-slate-800 text-slate-200'}`}
            >
              <Radio size={15} />
              {isBeaconActive ? 'Маяк ВКЛ — выключить' : 'Включить маяк'}
            </button>
            <p className="text-[10px] text-slate-500 mt-2">
              Передача раз в 30 секунд, только когда TX свободен.
            </p>
          </div>

          <div className="bg-slate-900/60 border border-red-900/40 rounded-2xl p-4">
            <h2 className="text-sm font-bold text-red-400 mb-3">Обнаруженные маяки</h2>
            {discoveredPings.length === 0 ? (
              <p className="text-xs text-slate-500">Пока ничего не принято.</p>
            ) : (
              <div className="space-y-2">
                {discoveredPings.map((ping) => (
                  <div key={ping.name} className="rounded-xl bg-slate-950 p-3 text-xs">
                    <p className="text-emerald-300 break-words">{ping.name}</p>
                    <p className="text-[10px] text-slate-500 mt-1">Последний RX: {ping.lastSeen}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="lg:col-span-2 flex flex-col gap-4 min-w-0">
          <div className="bg-slate-900/60 border border-red-900/40 rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-bold text-red-400">Чат / журнал пакетов</h2>
              <button
                type="button"
                onClick={runSelfTest}
                disabled={selfTest.status === 'running' || isTransmitting}
                className="min-h-10 px-3 py-2 bg-indigo-950 disabled:opacity-50 text-indigo-200 border border-indigo-800/60 rounded-xl text-xs"
              >
                {selfTest.status === 'running' ? 'Self-test выполняется…' : 'Реальный self-test'}
              </button>
            </div>

            <div className={`mb-3 rounded-xl border p-3 text-xs ${
              selfTest.status === 'pass'
                ? 'border-emerald-800/70 bg-emerald-950/40'
                : selfTest.status === 'fail'
                  ? 'border-red-800/70 bg-red-950/40'
                  : 'border-slate-800 bg-slate-950/70'
            }`}>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <span className="font-bold text-slate-200">SELF-TEST DIAGNOSTICS</span>
                <span className={`font-bold ${
                  selfTest.status === 'pass'
                    ? 'text-emerald-300'
                    : selfTest.status === 'fail'
                      ? 'text-red-300'
                      : selfTest.status === 'running'
                        ? 'text-amber-300'
                        : 'text-slate-500'
                }`}>
                  {selfTest.status === 'pass'
                    ? 'PASS'
                    : selfTest.status === 'fail'
                      ? 'FAIL'
                      : selfTest.status === 'running'
                        ? 'RUNNING'
                        : 'IDLE'}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {SELF_TEST_STEPS.map(([key, label]) => {
                  const step = selfTest.steps[key];
                  const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '○';
                  return (
                    <div key={key} className="text-[11px] text-slate-300 break-words">
                      {icon} {label}{step.detail ? ` · ${step.detail}` : ''}
                    </div>
                  );
                })}
              </div>
              {selfTest.reason && (
                <p className={`mt-2 text-[11px] ${selfTest.status === 'fail' ? 'text-red-300' : 'text-emerald-300'}`}>
                  {selfTest.reason}
                </p>
              )}
            </div>

            <div className="bg-slate-950 rounded-xl p-3 h-[360px] overflow-y-auto space-y-3 mb-3">
              {messages.map((msg) => {
                const outgoing = msg.kind === 'outgoing';
                const system = msg.kind === 'system';

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${outgoing ? 'items-end' : 'items-start'}`}
                  >
                    <span className="text-[10px] text-slate-500 mb-1">
                      {msg.sender} · {msg.time}
                    </span>
                    <div
                      className={`p-3 rounded-2xl text-xs max-w-[88%] break-words ${
                        system
                          ? 'bg-slate-800 text-slate-300'
                          : outgoing
                            ? 'bg-red-900 text-white'
                            : 'bg-emerald-950 text-emerald-100'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                );
              })}
            </div>

            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                maxLength={160}
                placeholder="Сообщение для акустической передачи..."
                className="flex-1 min-w-0 bg-slate-950 border border-red-900/50 rounded-xl px-4 py-3 text-base md:text-xs text-red-100 outline-none focus:border-red-500"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || draftTooLarge}
                className="min-w-12 min-h-11 px-4 py-2 bg-red-700 disabled:opacity-40 text-white rounded-xl text-xs flex items-center justify-center"
                aria-label="Отправить акустический пакет"
              >
                <Send size={16} />
              </button>
            </form>
            <p className={`mt-2 text-[10px] ${draftTooLarge ? 'text-red-300' : 'text-slate-500'}`}>
              Payload: {draftPayloadBytes}/{AUDIO_CONFIG.maxPayloadBytes} байт
              {draftTooLarge ? ' — сократите сообщение' : ''}
            </p>
          </div>

          <div className="bg-slate-900/60 border border-red-900/40 rounded-2xl p-4">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-bold text-red-400">Приёмник RX</h2>
                <p className="text-[11px] text-slate-500 mt-1">{rxStatus}</p>
              </div>
              <div className="text-right text-[10px] text-slate-500">
                <p>Signal RMS: {signalLevel.toFixed(4)}</p>
                <p>
                  Tone: {lastTone ? `${lastTone.frequency} Hz · ${lastTone.confidence.toFixed(2)}×` : '—'}
                </p>
                <p>Marker: {markerProgressView}/{AUDIO_CONFIG.startMarker.length}</p>
              </div>
            </div>

            <div className="h-24 bg-slate-950 rounded-xl overflow-hidden mb-3 relative">
              <canvas
                ref={canvasRef}
                width={900}
                height={96}
                className="w-full h-full"
              />
              {!isListening && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
                  Микрофон отключен
                </div>
              )}
            </div>

            <div className="mb-3 rounded-xl bg-slate-950/80 border border-slate-800 p-2.5">
              <p className="text-[10px] text-slate-500 mb-1">Последние распознанные тоны</p>
              <p className="text-[11px] text-emerald-300 break-words leading-5">
                {recentTones.length > 0
                  ? recentTones.map((tone) => tone.frequency).join(' → ')
                  : '—'}
              </p>
              <p className="text-[10px] text-slate-600 mt-1">
                Preamble: {AUDIO_CONFIG.startMarker.join(' → ')} Hz
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
              <label className="text-xs text-slate-300">
                Чувствительность RX: {rxSensitivity}/5
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={rxSensitivity}
                  onChange={(event) => setRxSensitivity(Number(event.target.value))}
                  className="mt-2 w-full"
                />
              </label>

              <button
                type="button"
                onClick={toggleListening}
                className={`min-h-11 px-4 py-2 rounded-xl text-xs flex items-center justify-center gap-2 ${isListening ? 'bg-red-950 text-red-200' : 'bg-emerald-900 text-emerald-100'}`}
              >
                {isListening ? <MicOff size={15} /> : <Mic size={15} />}
                {isListening ? 'Выключить RX' : 'Включить RX'}
              </button>
            </div>

            {micSettings && (
              <div className={`mt-3 rounded-xl p-3 text-[11px] flex gap-2 items-start ${echoCancellationOn ? 'bg-amber-950/70 text-amber-200' : 'bg-emerald-950/60 text-emerald-200'}`}>
                {echoCancellationOn ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
                <div>
                  <p>
                    echoCancellation: {String(micSettings.echoCancellation ?? 'unknown')}
                  </p>
                  <p>
                    noiseSuppression: {String(micSettings.noiseSuppression ?? 'unknown')} · autoGainControl: {String(micSettings.autoGainControl ?? 'unknown')}
                  </p>
                  {echoCancellationOn && (
                    <p className="mt-1">
                      Браузер/ОС оставил подавление эха включённым. Self-RX на одном телефоне может не услышать собственный динамик.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
