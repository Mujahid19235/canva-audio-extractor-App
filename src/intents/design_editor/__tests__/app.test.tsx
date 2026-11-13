import { useFeatureSupport, useSelection } from "@canva/app-hooks";
import { getTemporaryUrl, upload } from "@canva/asset";
import { addAudioTrack } from "@canva/design";
import type { Feature } from "@canva/platform";
import { auth } from "@canva/user";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderInTestProvider } from "../../../utils/test_render";
import { App } from "../app";

jest.mock("@canva/app-hooks");

describe("Audio Extractor App", () => {
  const mockIsSupported = jest.fn();
  const mockUseFeatureSupport = jest.mocked(useFeatureSupport);
  const mockUseSelection = jest.mocked(useSelection);
  const mockGetTemporaryUrl = jest.mocked(getTemporaryUrl);
  const mockUpload = jest.mocked(upload);
  const mockAddAudioTrack = jest.mocked(addAudioTrack);
  const mockGetCanvaUserToken = jest.mocked(auth.getCanvaUserToken);

  const mockWhenUploaded = jest.fn();
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;

    mockIsSupported.mockImplementation((fn: Feature) => fn === addAudioTrack);
    mockUseFeatureSupport.mockReturnValue(mockIsSupported);
    mockGetCanvaUserToken.mockResolvedValue("mock-jwt-token" as never);
    mockWhenUploaded.mockResolvedValue(undefined);
    mockUpload.mockResolvedValue({
      ref: "audio-ref-123" as never,
      whenUploaded: mockWhenUploaded,
    });
    mockAddAudioTrack.mockResolvedValue(undefined);
    mockGetTemporaryUrl.mockResolvedValue({
      type: "video",
      ref: "video-ref-1" as never,
      url: "https://media.canva.com/temp/video.mp4",
    });

    mockUseSelection.mockReturnValue({
      scope: "video",
      count: 1,
      read: jest.fn().mockResolvedValue({
        contents: [{ ref: "video-ref-1" }],
        save: jest.fn(),
      }),
    } as never);
  });

  it("extracts audio from a selected Canva video and adds it to the design when supported", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-1",
          audioUrl: "https://api.example.com/api/audio/token-1",
          mimeType: "audio/mpeg",
          durationMs: 4200,
          title: "Extracted audio",
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const { getByRole, findByText } = renderInTestProvider(<App />);

    fireEvent.click(getByRole("radio", { name: "Selected in Canva" }));

    const extractBtn = getByRole("button", {
      name: "Extract",
    }) as HTMLButtonElement;
    expect(extractBtn.disabled).toBe(false);

    fireEvent.click(extractBtn);

    await findByText(
      /Audio extracted, uploaded to Canva, and added to your design/i,
    );

    expect(mockGetTemporaryUrl).toHaveBeenCalledWith({
      type: "video",
      ref: "video-ref-1",
    });
    expect(mockUpload).toHaveBeenCalledWith({
      type: "audio",
      mimeType: "audio/mpeg",
      url: "https://api.example.com/api/audio/token-1",
      durationMs: 4200,
      title: "Extracted audio",
      aiDisclosure: "none",
    });
    expect(mockWhenUploaded).toHaveBeenCalled();
    expect(mockAddAudioTrack).toHaveBeenCalledWith({
      ref: "audio-ref-123",
    });
  });

  it("uploads audio to Canva library without calling addAudioTrack when unsupported", async () => {
    mockIsSupported.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-2",
          audioUrl: "https://api.example.com/api/audio/token-2",
          mimeType: "audio/mpeg",
          durationMs: 3000,
          title: "Extracted audio",
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const { getByRole, findByText } = renderInTestProvider(<App />);

    fireEvent.click(getByRole("radio", { name: "Selected in Canva" }));
    fireEvent.click(getByRole("button", { name: "Extract" }));

    await findByText(
      /Automatic audio track insertion is not supported in this design type/i,
    );

    expect(mockUpload).toHaveBeenCalled();
    expect(mockWhenUploaded).toHaveBeenCalled();
    expect(mockAddAudioTrack).not.toHaveBeenCalled();
  });

  it("extracts audio from a local device video file", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-3",
          audioUrl: "https://api.example.com/api/audio/token-3",
          mimeType: "audio/mpeg",
          durationMs: 5000,
          title: "clip",
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const { container, getByRole, findByText } = renderInTestProvider(
      <App />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const videoFile = new File(["video-bytes"], "clip.mp4", {
      type: "video/mp4",
    });
    fireEvent.change(fileInput, { target: { files: [videoFile] } });

    await findByText("clip.mp4");

    fireEvent.click(getByRole("button", { name: "Extract" }));

    await findByText(
      /Audio extracted, uploaded to Canva, and added to your design/i,
    );
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "clip",
        durationMs: 5000,
      }),
    );
  });

  it("displays a clear error message when extraction fails (e.g., no audio track)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        error: "This video does not contain an audio track.",
      }),
    } as Response);

    const { getByRole, findByText } = renderInTestProvider(<App />);

    fireEvent.click(getByRole("radio", { name: "Selected in Canva" }));
    fireEvent.click(getByRole("button", { name: "Extract" }));

    await findByText("This video does not contain an audio track.");
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAddAudioTrack).not.toHaveBeenCalled();
  });

  it("displays a clear error and cleans up temp audio when Canva upload fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-4",
          audioUrl: "https://api.example.com/api/audio/token-4",
          mimeType: "audio/mpeg",
          durationMs: 2500,
          title: "Extracted audio",
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    mockWhenUploaded.mockRejectedValueOnce(new Error("Upload quota exceeded"));

    const { getByRole, findByText } = renderInTestProvider(<App />);

    fireEvent.click(getByRole("radio", { name: "Selected in Canva" }));
    fireEvent.click(getByRole("button", { name: "Extract" }));

    await findByText("Upload quota exceeded");
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/audio/token-4"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("supports OR Choose From Device fallback inside Selected in Canva without switching tabs and shows two-step progress", async () => {
    mockUseSelection.mockReturnValue({
      scope: "video",
      count: 0,
      read: jest.fn().mockResolvedValue({
        contents: [],
        save: jest.fn(),
      }),
    } as never);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "token-5",
          audioUrl: "https://api.example.com/api/audio/token-5",
          mimeType: "audio/mpeg",
          durationMs: 3600,
          title: "fallback",
        }),
      } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const { container, getByRole, findByText, getAllByLabelText } =
      renderInTestProvider(<App />);

    expect(getByRole("radiogroup")).toBeTruthy();

    const selectedInCanvaTab = getByRole("radio", {
      name: "Selected in Canva",
    });
    fireEvent.click(selectedInCanvaTab);

    const extractBtn = getByRole("button", {
      name: "Extract",
    }) as HTMLButtonElement;
    expect(extractBtn.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(
      getByRole("button", { name: "Select a video in editor or Uploads" }),
    );
    expect(
      getByRole("button", { name: "OR Choose From Device" }),
    ).toBeTruthy();

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const videoFile = new File(["video-bytes"], "fallback.mp4", {
      type: "video/mp4",
    });
    fireEvent.change(fileInput, { target: { files: [videoFile] } });

    await findByText("fallback.mp4");
    expect(selectedInCanvaTab.getAttribute("aria-checked")).toBe("true");
    expect(extractBtn.getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(extractBtn);

    await findByText(/Step 1 — Extracting Audio/);
    await findByText(/Step 2 — Uploading to Canva/);
    await findByText(
      /Audio extracted, uploaded to Canva, and added to your design/i,
    );

    expect(getAllByLabelText("Completed")).toHaveLength(2);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "fallback",
        durationMs: 3600,
      }),
    );
  });
});
