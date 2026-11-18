import { act, renderHook, waitFor } from "@testing-library/react";
import type { VoiceMessagesClientConfig } from "../api/client_config";
import type { UploadVoiceMessageResponse } from "../api/voice_messages";
import {
  extractWaveformPeaksFromBlob,
  waveformBarCount,
} from "../audio/waveform";
import { useVoiceRecorderController } from "./use_voice_recorder_controller";

const controllerMocks = vi.hoisted(() => ({
  loadClientConfig: vi.fn(),
  uploadVoiceMessage: vi.fn(),
  transcribeVoiceMessageBlob: vi.fn(),
}));

vi.mock("../api/client_config", () => ({
  loadClientConfig: controllerMocks.loadClientConfig,
}));

vi.mock("../api/voice_messages", () => ({
  uploadVoiceMessage: controllerMocks.uploadVoiceMessage,
}));

vi.mock("../transcription/client_transcription", () => ({
  transcribeVoiceMessageBlob: controllerMocks.transcribeVoiceMessageBlob,
}));

vi.mock("../audio/waveform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audio/waveform")>();
  return {
    ...actual,
    extractWaveformPeaksFromBlob: vi.fn(async () =>
      Array.from(
        { length: actual.waveformBarCount },
        (_, index) => index / actual.waveformBarCount,
      ),
    ),
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  return new DOMException("Operation aborted", "AbortError");
}

const baseConfig: VoiceMessagesClientConfig = {
  maxVoiceMessageBytes: 25 * 1024 * 1024,
  maxRecordingDurationMs: 21_600_000,
  voiceMessagesEnabled: true,
  uploadedAudioPreviewEnabled: true,
  clientTranscriptionEnabled: false,
  clientTranscriptionAutoStart: false,
  clientTranscriptionModel: "whisper-tiny",
  clientTranscriptionQuantization: "hybrid",
  clientTranscriptionLanguage: "",
};

const transcriptionConfig: VoiceMessagesClientConfig = {
  ...baseConfig,
  clientTranscriptionEnabled: true,
};

const uploadResponse: UploadVoiceMessageResponse = {
  post: { id: "post-id" } as UploadVoiceMessageResponse["post"],
  file_info: {
    id: "file-id",
  } as UploadVoiceMessageResponse["file_info"],
};

type FakeMediaRecorderEvent = {
  data: Blob;
};

class FakeMediaRecorder {
  public static isTypeSupported = vi.fn(() => true);
  public static instances: FakeMediaRecorder[] = [];
  public ondataavailable: ((event: FakeMediaRecorderEvent) => void) | null =
    null;
  public onstop: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public mimeType = "audio/webm;codecs=opus";
  public state: RecordingState = "inactive";

  public constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  public start() {
    this.state = "recording";
  }

  public stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["voice-data"], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

function installRecorderEnvironment() {
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
      })),
    },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-message");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return track;
}

async function recordAndReview() {
  const hook = renderHook(() =>
    useVoiceRecorderController({ channelId: "channel-id" }, baseConfig),
  );
  const { result } = hook;

  await act(async () => {
    await result.current.startRecording();
  });
  expect(result.current.status).toBe("recording");

  Date.now = vi.fn(() => 3_000);
  act(() => result.current.stopRecording());
  await waitFor(() => {
    expect(result.current.status).toBe("review");
  });
  expect(result.current.review).not.toBeNull();
  expect(result.current.review?.limitError).toBe("");
  return hook;
}

function installPendingUpload(): Deferred<UploadVoiceMessageResponse> {
  const pending = deferred<UploadVoiceMessageResponse>();
  controllerMocks.uploadVoiceMessage.mockImplementationOnce((input) => {
    input.signal?.addEventListener(
      "abort",
      () => pending.reject(abortError()),
      { once: true },
    );
    return pending.promise;
  });
  return pending;
}

describe("useVoiceRecorderController review races", () => {
  const originalMediaDevices = navigator.mediaDevices;
  const realDateNow = Date.now;

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.isTypeSupported.mockReturnValue(true);
    Date.now = vi.fn(() => 1_000);
    installRecorderEnvironment();
    controllerMocks.loadClientConfig.mockReset();
    controllerMocks.loadClientConfig.mockResolvedValue(baseConfig);
    controllerMocks.uploadVoiceMessage.mockReset();
    controllerMocks.uploadVoiceMessage.mockResolvedValue(uploadResponse);
    controllerMocks.transcribeVoiceMessageBlob.mockReset();
    vi.mocked(extractWaveformPeaksFromBlob).mockReset();
    vi.mocked(extractWaveformPeaksFromBlob).mockResolvedValue(
      Array.from({ length: waveformBarCount }, (_, index) => index / 24),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    Date.now = realDateNow;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("refreshes limits and applies the returned limit error and waveform", async () => {
    const hook = await recordAndReview();
    const loweredConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    };
    controllerMocks.loadClientConfig.mockImplementationOnce(
      async () => loweredConfig,
    );

    await act(async () => {
      await hook.result.current.recheckRecordingLimits();
    });

    expect(hook.result.current.checkingLimits).toBe(false);
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.limits).toEqual(loweredConfig);
    expect(hook.result.current.review?.limitError).toContain("size limit");
  });

  it("surfaces refresh failures with the existing error semantics and keeps the review", async () => {
    const hook = await recordAndReview();
    controllerMocks.loadClientConfig.mockRejectedValueOnce(
      new Error("settings unavailable"),
    );

    await act(async () => {
      await hook.result.current.recheckRecordingLimits();
    });

    expect(hook.result.current.checkingLimits).toBe(false);
    expect(hook.result.current.error).toBe("settings unavailable");
    expect(hook.result.current.review).not.toBeNull();

    controllerMocks.loadClientConfig.mockRejectedValueOnce("not an error");
    await act(async () => {
      await hook.result.current.recheckRecordingLimits();
    });
    expect(hook.result.current.error).toBe("Could not check recording limits");
  });

  it("lets a newer limit refresh invalidate an in-flight refresh when responses arrive out of order", async () => {
    const hook = await recordAndReview();
    const firstRequest = deferred<VoiceMessagesClientConfig>();
    const secondRequest = deferred<VoiceMessagesClientConfig>();
    const staleConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxRecordingDurationMs: 111,
    };
    const currentConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    };
    controllerMocks.loadClientConfig
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    const firstSignal = controllerMocks.loadClientConfig.mock.calls.at(-1)?.[0];
    expect(firstSignal?.aborted).toBe(false);
    expect(hook.result.current.checkingLimits).toBe(true);

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    expect(firstSignal?.aborted).toBe(true);
    const secondSignal =
      controllerMocks.loadClientConfig.mock.calls.at(-1)?.[0];

    // The second response lands first and wins.
    await act(async () => {
      secondRequest.resolve(currentConfig);
      await Promise.resolve();
    });
    expect(hook.result.current.checkingLimits).toBe(false);
    expect(hook.result.current.limits.maxVoiceMessageBytes).toBe(1);
    expect(hook.result.current.review?.limitError).toContain("size limit");

    // The stale first response then arrives and must not overwrite anything.
    await act(async () => {
      firstRequest.resolve(staleConfig);
      await Promise.resolve();
    });
    expect(secondSignal?.aborted).toBe(false);
    expect(hook.result.current.limits.maxVoiceMessageBytes).toBe(1);
    expect(hook.result.current.limits.maxRecordingDurationMs).toBe(
      baseConfig.maxRecordingDurationMs,
    );
    expect(hook.result.current.review?.limitError).toContain("size limit");
    expect(hook.result.current.checkingLimits).toBe(false);
  });

  it("ignores a rejected stale refresh without touching the newer state", async () => {
    const hook = await recordAndReview();
    const firstRequest = deferred<VoiceMessagesClientConfig>();
    controllerMocks.loadClientConfig.mockImplementationOnce(
      () => firstRequest.promise,
    );

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    const firstSignal = controllerMocks.loadClientConfig.mock.calls.at(-1)?.[0];

    const currentConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    };
    controllerMocks.loadClientConfig.mockImplementationOnce(
      async () => currentConfig,
    );
    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    expect(firstSignal?.aborted).toBe(true);

    await waitFor(() => {
      expect(hook.result.current.review?.limitError).toContain("size limit");
    });

    await act(async () => {
      firstRequest.reject(abortError());
      await Promise.resolve();
    });
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.review?.limitError).toContain("size limit");
    expect(hook.result.current.checkingLimits).toBe(false);
  });

  it("does not write a late refresh back after the review is cancelled", async () => {
    const hook = await recordAndReview();
    const lateConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    };
    const lateRequest = deferred<VoiceMessagesClientConfig>();
    controllerMocks.loadClientConfig.mockImplementationOnce(
      () => lateRequest.promise,
    );

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    act(() => hook.result.current.cancelRecording());

    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.checkingLimits).toBe(false);

    await act(async () => {
      lateRequest.resolve(lateConfig);
      await Promise.resolve();
    });
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.limits.maxVoiceMessageBytes).toBe(
      baseConfig.maxVoiceMessageBytes,
    );
  });

  it("does not write a late waveform back after the review is cancelled", async () => {
    const hook = await recordAndReview();
    const configRequest = deferred<VoiceMessagesClientConfig>();
    const waveformRequest = deferred<number[]>();
    controllerMocks.loadClientConfig.mockImplementationOnce(
      () => configRequest.promise,
    );
    vi.mocked(extractWaveformPeaksFromBlob).mockReturnValueOnce(
      waveformRequest.promise,
    );

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    await act(async () => {
      configRequest.resolve(baseConfig);
      await Promise.resolve();
    });
    const waveformCallsAfterConfig = vi.mocked(extractWaveformPeaksFromBlob)
      .mock.calls.length;
    // One call during review creation, plus the recheck's fresh extraction.
    expect(waveformCallsAfterConfig).toBeGreaterThanOrEqual(2);

    act(() => hook.result.current.cancelRecording());
    await act(async () => {
      waveformRequest.resolve([0.42]);
      await Promise.resolve();
    });

    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.status).toBe("idle");
  });

  it("does not write a stale refresh onto a replacement review", async () => {
    const hook = await recordAndReview();
    const firstReviewId = hook.result.current.review?.id;
    const staleRequest = deferred<VoiceMessagesClientConfig>();
    const staleConfig: VoiceMessagesClientConfig = {
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    };
    controllerMocks.loadClientConfig.mockImplementationOnce(
      () => staleRequest.promise,
    );

    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    act(() => hook.result.current.cancelRecording());
    await act(async () => {
      await hook.result.current.startRecording();
    });
    Date.now = vi.fn(() => 5_000);
    act(() => hook.result.current.stopRecording());
    await waitFor(() => {
      expect(hook.result.current.status).toBe("review");
    });
    const replacementReviewId = hook.result.current.review?.id;
    expect(replacementReviewId).not.toBe(firstReviewId);

    await act(async () => {
      staleRequest.resolve(staleConfig);
      await Promise.resolve();
    });
    expect(hook.result.current.review?.id).toBe(replacementReviewId);
    expect(hook.result.current.review?.limitError).toBe("");
    expect(hook.result.current.limits.maxVoiceMessageBytes).toBe(
      baseConfig.maxVoiceMessageBytes,
    );
  });

  it("aborts pending refreshes and uploads when the panel unmounts", async () => {
    const hook = await recordAndReview();
    const refreshRequest = deferred<VoiceMessagesClientConfig>();
    controllerMocks.loadClientConfig.mockImplementationOnce(
      () => refreshRequest.promise,
    );
    await act(async () => {
      void hook.result.current.recheckRecordingLimits();
    });
    const refreshSignal =
      controllerMocks.loadClientConfig.mock.calls.at(-1)?.[0];

    const pendingUpload = installPendingUpload();
    await act(async () => {
      void hook.result.current.sendRecording();
    });
    const uploadInput = controllerMocks.uploadVoiceMessage.mock.calls[0]?.[0];

    expect(() => hook.unmount()).not.toThrow();
    expect(refreshSignal?.aborted).toBe(true);
    expect(uploadInput?.signal?.aborted).toBe(true);

    await act(async () => {
      refreshRequest.resolve({ ...baseConfig, maxVoiceMessageBytes: 1 });
      pendingUpload.resolve(uploadResponse);
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("uploading");
  });

  it("cancels a running transcription safely when sending and uploads once", async () => {
    controllerMocks.loadClientConfig.mockResolvedValue(transcriptionConfig);
    const hook = await recordAndReview();
    const transcription = deferred<string>();
    controllerMocks.transcribeVoiceMessageBlob.mockImplementationOnce(
      (_blob, _mimeType, options) => {
        options.signal?.addEventListener(
          "abort",
          () => transcription.reject(abortError()),
          { once: true },
        );
        return transcription.promise;
      },
    );

    await act(async () => {
      void hook.result.current.startTranscription();
    });
    await waitFor(() => {
      expect(hook.result.current.transcriptionStatus).toBe("transcribing");
    });
    const transcriptionSignal =
      controllerMocks.transcribeVoiceMessageBlob.mock.calls[0]?.[2]?.signal;
    expect(transcriptionSignal?.aborted).toBe(false);

    const pendingUpload = installPendingUpload();
    await act(async () => {
      void hook.result.current.sendRecording();
    });

    expect(transcriptionSignal?.aborted).toBe(true);
    expect(hook.result.current.transcriptionStatus).toBe("idle");
    expect(hook.result.current.status).toBe("uploading");
    expect(controllerMocks.uploadVoiceMessage).toHaveBeenCalledTimes(1);
    const uploadInput = controllerMocks.uploadVoiceMessage.mock.calls[0]?.[0];
    expect(uploadInput?.channelId).toBe("channel-id");
    expect(uploadInput?.blob).toBeInstanceOf(Blob);
    expect(uploadInput?.signal?.aborted).toBe(false);

    await act(async () => {
      pendingUpload.resolve(uploadResponse);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("idle");
    });
    expect(hook.result.current.review).toBeNull();

    // The aborted transcription settling late must not surface an error.
    await act(async () => {
      transcription.reject(abortError());
      await Promise.resolve();
    });
    expect(hook.result.current.transcriptionStatus).toBe("idle");
    expect(hook.result.current.transcriptionError).toBe("");
  });

  it("does not start a second upload while one is in progress", async () => {
    const hook = await recordAndReview();
    installPendingUpload();

    await act(async () => {
      void hook.result.current.sendRecording();
    });
    expect(hook.result.current.status).toBe("uploading");

    await act(async () => {
      void hook.result.current.sendRecording();
      void hook.result.current.sendRecording();
    });
    expect(controllerMocks.uploadVoiceMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the review and error after an upload failure and allows a retry", async () => {
    const hook = await recordAndReview();
    controllerMocks.uploadVoiceMessage.mockRejectedValueOnce(
      new Error("upload rejected"),
    );

    await act(async () => {
      await hook.result.current.sendRecording();
    });
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.error).toBe("upload rejected");
    expect(hook.result.current.review).not.toBeNull();

    await act(async () => {
      await hook.result.current.sendRecording();
    });
    expect(controllerMocks.uploadVoiceMessage).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(hook.result.current.status).toBe("idle");
    });
    expect(hook.result.current.review).toBeNull();
  });

  it("aborts an in-flight upload on cancellation and ignores its late response", async () => {
    const hook = await recordAndReview();
    const pendingUpload = installPendingUpload();

    await act(async () => {
      void hook.result.current.sendRecording();
    });
    const uploadInput = controllerMocks.uploadVoiceMessage.mock.calls[0]?.[0];

    act(() => hook.result.current.cancelRecording());
    expect(uploadInput?.signal?.aborted).toBe(true);
    expect(hook.result.current.status).toBe("idle");

    await act(async () => {
      pendingUpload.reject(abortError());
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.error).toBe("");
  });

  it("blocks sending when the refreshed limits reject the recording", async () => {
    const hook = await recordAndReview();
    controllerMocks.loadClientConfig.mockImplementationOnce(async () => ({
      ...baseConfig,
      maxVoiceMessageBytes: 1,
    }));

    await act(async () => {
      await hook.result.current.sendRecording();
    });

    expect(controllerMocks.uploadVoiceMessage).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("review");
    expect(hook.result.current.review?.limitError).toContain("size limit");
  });
});
