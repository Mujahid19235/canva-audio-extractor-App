import { useFeatureSupport, useSelection } from "@canva/app-hooks";
import {
  Alert,
  Box,
  Button,
  FileInput,
  FormField,
  Rows,
  SegmentedControl,
  Text,
  Title,
} from "@canva/app-ui-kit";
import { addAudioTrack } from "@canva/design";
import { useRef, useState } from "react";
import { useIntl } from "react-intl";
import * as styles from "styles/components.css";
import {
  cleanupExtractedAudio,
  extractAudioFromCanvasSelection,
  extractAudioFromLocalFile,
  uploadAndInsertAudio,
  validateLocalVideoFile,
} from "./audio_extractor_service";

type VideoSource = "canvas" | "device";

type ProcessingStage = "idle" | "extracting" | "uploading" | "completed";

type StepState = "pending" | "active" | "completed";

const ACCEPTED_VIDEO_FORMATS = [
  "video/*",
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".flv",
  ".wmv",
  ".3gp",
  ".ogv",
  ".ts",
];

interface StatusMessage {
  tone: "positive" | "critical";
  text: string;
}

export const App = () => {
  const intl = useIntl();
  const isSupported = useFeatureSupport();
  const canAddAudioTrack = isSupported(addAudioTrack);
  const videoSelection = useSelection("video");

  const [source, setSource] = useState<VideoSource>("device");
  const [localFile, setLocalFile] = useState<File | undefined>(undefined);
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [status, setStatus] = useState<StatusMessage | undefined>(undefined);
  const [showCanvasGuide, setShowCanvasGuide] = useState(false);
  const hiddenFileInputContainerRef = useRef<HTMLDivElement | null>(null);

  const isProcessing = stage === "extracting" || stage === "uploading";
  const showProgress = stage !== "idle";
  const effectiveSource: VideoSource =
    source === "device"
      ? "device"
      : videoSelection.count > 0
        ? "canvas"
        : localFile
          ? "device"
          : "canvas";
  const hasValidSource =
    effectiveSource === "canvas"
      ? videoSelection.count > 0
      : localFile !== undefined;

  const handleSourceChange = (nextSource: VideoSource) => {
    setSource(nextSource);
    setStatus(undefined);
    setStage("idle");
    setShowCanvasGuide(false);
    if (nextSource === "canvas") {
      setLocalFile(undefined);
    }
  };

  const handleAcceptedFiles = (files: File[]) => {
    const file = files[0];
    setStatus(undefined);
    setStage("idle");

    if (!file) {
      setLocalFile(undefined);
      return;
    }

    const validationError = validateLocalVideoFile(file);
    if (validationError === "empty_file") {
      setLocalFile(undefined);
      setStatus({
        tone: "critical",
        text: intl.formatMessage({
          defaultMessage: "The selected file is empty.",
          description: "Error shown when the user selects an empty video file.",
        }),
      });
      return;
    }

    if (validationError === "file_too_large") {
      setLocalFile(undefined);
      setStatus({
        tone: "critical",
        text: intl.formatMessage({
          defaultMessage: "Video must be 250 MB or smaller.",
          description:
            "Error shown when the selected video exceeds Canva's 250 MB limit.",
        }),
      });
      return;
    }

    if (validationError === "unsupported_type") {
      setLocalFile(undefined);
      setStatus({
        tone: "critical",
        text: intl.formatMessage({
          defaultMessage: "Please select a supported video file (MP4, MOV, WebM).",
          description:
            "Error shown when the selected file is not a supported video format.",
        }),
      });
      return;
    }

    setLocalFile(file);
  };

  const handleOpenDeviceFilePicker = () => {
    const fileInput = hiddenFileInputContainerRef.current?.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    fileInput?.click();
  };

  const handleRejectedFiles = () => {
    setLocalFile(undefined);
    setStage("idle");
    setStatus({
      tone: "critical",
      text: intl.formatMessage({
        defaultMessage: "Please select a supported video file (MP4, MOV, WebM).",
        description:
          "Error shown when the selected file is rejected by the file picker.",
      }),
    });
  };

  const handleExtract = async () => {
    if (!hasValidSource || isProcessing) {
      return;
    }

    setStatus(undefined);
    setStage("extracting");
    let extractedToken: string | undefined;

    try {
      const extracted =
        effectiveSource === "canvas"
          ? await extractAudioFromCanvasSelection(videoSelection)
          : await extractAudioFromLocalFile(localFile as File);

      extractedToken = extracted.token;
      setStage("uploading");

      const { addedToTimeline } = await uploadAndInsertAudio({
        audioUrl: extracted.audioUrl,
        durationMs: extracted.durationMs,
        title: extracted.title,
        canAddAudioTrack,
      });

      setStage("completed");
      setStatus({
        tone: "positive",
        text: addedToTimeline
          ? intl.formatMessage({
              defaultMessage:
                "Audio extracted, uploaded to Canva, and added to your design.",
              description:
                "Success message when extracted audio is uploaded and added to the design timeline.",
            })
          : intl.formatMessage({
              defaultMessage:
                "Audio extracted and uploaded to your Canva media library. Automatic audio track insertion is not supported in this design type—add it manually from Uploads.",
              description:
                "Success message when extracted audio is uploaded to Canva but the current design type does not support automatic audio track insertion.",
            }),
      });
    } catch (error) {
      setStage("idle");
      const message =
        error instanceof Error && error.message
          ? error.message
          : intl.formatMessage({
              defaultMessage: "Something went wrong while extracting audio.",
              description: "Fallback error message when audio extraction fails.",
            });

      setStatus({
        tone: "critical",
        text: message,
      });
    } finally {
      if (extractedToken) {
        await cleanupExtractedAudio(extractedToken);
      }
    }
  };

  const step1State: StepState =
    stage === "extracting"
      ? "active"
      : stage === "uploading" || stage === "completed"
        ? "completed"
        : "pending";
  const step2State: StepState =
    stage === "uploading"
      ? "active"
      : stage === "completed"
        ? "completed"
        : "pending";

  const sourceOptions = [
    {
      value: "device" as const,
      label: intl.formatMessage({
        defaultMessage: "From Device",
        description: "Option to extract audio from a local video file on the user's device.",
      }),
    },
    {
      value: "canvas" as const,
      label: intl.formatMessage({
        defaultMessage: "Selected in Canva",
        description: "Option to extract audio from a video selected on the Canva canvas.",
      }),
    },
  ];

  return (
    <div className={styles.scrollContainer}>
      <Rows spacing="2u">
        <Title size="medium">
          {intl.formatMessage({
            defaultMessage: "Audio Extractor",
            description: "Main title of the Audio Extractor Canva app.",
          })}
        </Title>

        <FormField
          label={intl.formatMessage({
            defaultMessage: "Video source",
            description: "Label for choosing the source of the video.",
          })}
          value={source}
          control={(props) => (
            <div className={styles.sourceSwitchWrap}>
              <SegmentedControl
                {...props}
                options={sourceOptions}
                value={source}
                onChange={handleSourceChange}
                disabled={isProcessing}
              />
            </div>
          )}
        />

        {source === "canvas" ? (
          <Box padding="1.5u" borderRadius="standard" background="neutralLow">
            {videoSelection.count === 0 ? (
              <Rows spacing="1u">
                <Button
                  variant="secondary"
                  stretch
                  onClick={() => setShowCanvasGuide((prev) => !prev)}
                >
                  {intl.formatMessage({
                    defaultMessage: "Select a video in editor or Uploads",
                    description:
                      "Interactive button prompt shown when no video is selected on the Canva canvas.",
                  })}
                </Button>
                {showCanvasGuide && (
                  <Rows spacing="1u">
                    <Rows spacing="0.5u">
                      <Text size="small" tone="secondary">
                        {intl.formatMessage({
                          defaultMessage:
                            "1. Open Uploads in Canva's left sidebar or click a video on your page.",
                          description:
                            "First step shown when the user clicks the video selection prompt.",
                        })}
                      </Text>
                      <Text size="small" tone="secondary">
                        {intl.formatMessage({
                          defaultMessage:
                            "2. Once selected on the canvas, click Extract below.",
                          description:
                            "Second step shown on a new line when the user clicks the video selection prompt.",
                        })}
                      </Text>
                    </Rows>
                    <div className={styles.orDivider}>
                      <span className={styles.orDividerLine} aria-hidden="true" />
                      <Text size="small" tone="secondary">
                        {intl.formatMessage({
                          defaultMessage: "OR",
                          description:
                            "Divider text between canvas instructions and device fallback button.",
                        })}
                      </Text>
                      <span className={styles.orDividerLine} aria-hidden="true" />
                    </div>
                    <div className={styles.fallbackDeviceButtonWrap}>
                      <Button
                        variant="tertiary"
                        stretch
                        onClick={handleOpenDeviceFilePicker}
                      >
                        {intl.formatMessage({
                          defaultMessage: "Choose From Device",
                          description:
                            "Shortcut button to open the device file picker directly.",
                        })}
                      </Button>
                    </div>
                  </Rows>
                )}
                {localFile && (
                  <Text size="small" tone="secondary">
                    {localFile.name}
                  </Text>
                )}
                <div
                  ref={hiddenFileInputContainerRef}
                  className={styles.srOnlyFileInput}
                  aria-hidden="true"
                >
                  <FileInput
                    multiple={false}
                    accept={ACCEPTED_VIDEO_FORMATS}
                    disabled={isProcessing}
                    onDropAcceptedFiles={handleAcceptedFiles}
                    onDropRejectedFiles={handleRejectedFiles}
                  />
                </div>
              </Rows>
            ) : videoSelection.count === 1 ? (
              <Text size="small">
                {intl.formatMessage({
                  defaultMessage: "1 video selected on canvas.",
                  description:
                    "Status text shown when one video is selected on the canvas.",
                })}
              </Text>
            ) : (
              <Text size="small">
                {intl.formatMessage(
                  {
                    defaultMessage:
                      "{count} videos selected. Audio will be extracted from the first selected video.",
                    description:
                      "Status text shown when multiple videos are selected on the canvas.",
                  },
                  { count: videoSelection.count },
                )}
              </Text>
            )}
          </Box>
        ) : (
          <Rows spacing="1u">
            <FileInput
              stretchButton
              multiple={false}
              accept={ACCEPTED_VIDEO_FORMATS}
              disabled={isProcessing}
              onDropAcceptedFiles={handleAcceptedFiles}
              onDropRejectedFiles={handleRejectedFiles}
            />
            {localFile && (
              <Text size="small" tone="secondary">
                {localFile.name}
              </Text>
            )}
          </Rows>
        )}

        <div className={styles.extractButtonWrap}>
          <Button
            variant="primary"
            onClick={handleExtract}
            disabled={!hasValidSource || isProcessing}
            stretch
          >
            {intl.formatMessage({
              defaultMessage: "Extract",
              description: "Primary action button to extract audio from the selected video.",
            })}
          </Button>
        </div>

        {showProgress && (
          <div className={styles.progressCard} aria-live="polite">
            <div className={styles.progressStep}>
              <div className={styles.progressHeader}>
                <Text size="small">
                  {intl.formatMessage({
                    defaultMessage: "Step 1 — Extracting Audio",
                    description: "Heading for the first stage of audio extraction.",
                  })}
                </Text>
                {step1State === "completed" && (
                  <span
                    className={styles.progressCheck}
                    aria-label={intl.formatMessage({
                      defaultMessage: "Completed",
                      description: "Accessible label for a completed step.",
                    })}
                  >
                    {intl.formatMessage({
                      defaultMessage: "✓",
                      description: "Checkmark symbol for a completed step.",
                    })}
                  </span>
                )}
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label={intl.formatMessage({
                  defaultMessage: "Extracting Audio",
                  description: "Accessible label for the audio extraction progress bar.",
                })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={step1State === "completed" ? 100 : undefined}
              >
                {step1State === "active" && (
                  <div className={styles.progressFillActive} />
                )}
                {step1State === "completed" && (
                  <div className={styles.progressFillDone} />
                )}
              </div>
              <Text size="small" tone="secondary">
                {intl.formatMessage({
                  defaultMessage: "Extracting MP3 audio...",
                  description:
                    "Status text shown for the audio extraction stage.",
                })}
              </Text>
            </div>

            <div className={styles.progressStep}>
              <div className={styles.progressHeader}>
                <Text size="small">
                  {intl.formatMessage({
                    defaultMessage: "Step 2 — Uploading to Canva",
                    description: "Heading for the second stage of uploading audio to Canva.",
                  })}
                </Text>
                {step2State === "completed" && (
                  <span
                    className={styles.progressCheck}
                    aria-label={intl.formatMessage({
                      defaultMessage: "Completed",
                      description: "Accessible label for a completed step.",
                    })}
                  >
                    {intl.formatMessage({
                      defaultMessage: "✓",
                      description: "Checkmark symbol for a completed step.",
                    })}
                  </span>
                )}
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label={intl.formatMessage({
                  defaultMessage: "Uploading to Canva",
                  description: "Accessible label for the Canva upload progress bar.",
                })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  step2State === "completed"
                    ? 100
                    : step2State === "pending"
                      ? 0
                      : undefined
                }
              >
                {step2State === "active" && (
                  <div className={styles.progressFillActive} />
                )}
                {step2State === "completed" && (
                  <div className={styles.progressFillDone} />
                )}
              </div>
              <Text size="small" tone="secondary">
                {intl.formatMessage({
                  defaultMessage: "Uploading audio to Canva...",
                  description:
                    "Status text shown for the Canva upload stage.",
                })}
              </Text>
            </div>
          </div>
        )}

        {status && <Alert tone={status.tone}>{status.text}</Alert>}
      </Rows>
    </div>
  );
};
