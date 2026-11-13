import { useFeatureSupport, useSelection } from "@canva/app-hooks";
import {
  Alert,
  Box,
  Button,
  FileInput,
  FormField,
  LoadingIndicator,
  Rows,
  SegmentedControl,
  Text,
  Title,
} from "@canva/app-ui-kit";
import { addAudioTrack } from "@canva/design";
import { useState } from "react";
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

type ProcessingStage = "idle" | "extracting" | "uploading";

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

  const isProcessing = stage !== "idle";
  const hasValidSource =
    source === "canvas" ? videoSelection.count > 0 : localFile !== undefined;

  const handleSourceChange = (nextSource: VideoSource) => {
    setSource(nextSource);
    setStatus(undefined);
  };

  const handleAcceptedFiles = (files: File[]) => {
    const file = files[0];
    setStatus(undefined);

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

  const handleRejectedFiles = () => {
    setLocalFile(undefined);
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
        source === "canvas"
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
      setStage("idle");
    }
  };

  const sourceOptions = [
    {
      value: "device" as const,
      label: intl.formatMessage({
        defaultMessage: "From device",
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
            <SegmentedControl
              {...props}
              options={sourceOptions}
              value={source}
              onChange={handleSourceChange}
              disabled={isProcessing}
            />
          )}
        />

        {source === "canvas" ? (
          <Box padding="1.5u" borderRadius="standard" background="neutralLow">
            {videoSelection.count === 0 ? (
              <Text size="small" tone="secondary">
                {intl.formatMessage({
                  defaultMessage:
                    "First select your video in editor and then it will extract.",
                  description:
                    "Helper text shown when no video is currently selected on the canvas.",
                })}
              </Text>
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
              accept={[
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
              ]}
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

        <Button
          variant="primary"
          onClick={handleExtract}
          disabled={!hasValidSource || isProcessing}
          loading={isProcessing}
          stretch
        >
          {intl.formatMessage({
            defaultMessage: "Extract",
            description: "Primary action button to extract audio from the selected video.",
          })}
        </Button>

        {isProcessing && (
          <Box display="flex" alignItems="center">
            <LoadingIndicator size="small" />
            <Box paddingStart="1u">
              <Text size="small" tone="secondary">
                {stage === "extracting"
                  ? intl.formatMessage({
                      defaultMessage: "Extracting MP3 audio...",
                      description:
                        "Loading indicator text while extracting audio from the video.",
                    })
                  : intl.formatMessage({
                      defaultMessage: "Uploading audio to Canva...",
                      description:
                        "Loading indicator text while uploading extracted audio to Canva.",
                    })}
              </Text>
            </Box>
          </Box>
        )}

        {status && <Alert tone={status.tone}>{status.text}</Alert>}
      </Rows>
    </div>
  );
};
