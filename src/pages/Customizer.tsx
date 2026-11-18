import { useEffect, useState } from "react";
import { Helmet, HelmetProvider } from "react-helmet-async";
import { AnimatePresence, motion } from "motion/react";
import { useSnapshot } from "valtio";

import state, {
  beginDecalRequest,
  clearDecalError,
  decalEnabledProperty,
  getDownloadReadiness,
  releaseDecalSlot,
  type DecalSlot,
} from "../store";
import { download } from "../assets";
import {
  captureCanvasToImage,
  prepareCanvasSnapshot,
  reader,
} from "../config/helpers";
import {
  EditorTabs,
  FilterTabs,
  DecalTypes,
  type DecalKey,
  type EditorTabName,
  type FilterTabName,
} from "../config/constants";
import { fadeAnimation, slideAnimation } from "../config/motion";
import {
  AIPicker,
  ColorPicker,
  CustomButton,
  FilePicker,
  Tab,
} from "../components";
import type {
  DalleErrorResponse,
  DalleSuccessResponse,
  GenerateResult,
} from "../../shared/dalle";

type FilterTabState = Record<FilterTabName, boolean>;

// Customizer
const Customizer = () => {
  // current snapshot state
  const snap = useSnapshot(state);

  // file state
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");

  // img loading state
  const [generatingImg, setGeneratingImg] = useState(false);

  // download state
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  // active tab state
  const [activeEditorTab, setActiveEditorTab] = useState<EditorTabName | "">(
    "",
  );
  // active filter tabs are derived from the store so external changes stay
  // in sync instead of drifting from a duplicated local copy.
  const activeFilterTab: FilterTabState = {
    logoShirt: snap.isLogoTexture,
    stylishShirt: snap.isFullTexture,
  };

  // downloads are only allowed once every enabled decal shows its texture
  const downloadState = getDownloadReadiness(snap);
  // decal load failures must be surfaced even when the slot fell back
  const decalError = (["logo", "full"] as DecalSlot[])
    .map((slot) => snap.decalStatus[slot].error)
    .find((message): message is string => Boolean(message));
  const statusNotice =
    downloadError ||
    decalError ||
    (downloadState.ready ? "" : downloadState.message);

  // handle active filter tab
  const handleActiveFilterTab = (tabName: FilterTabName) => {
    switch (tabName) {
      // logo texture tab
      case "logoShirt":
        if (state.isLogoTexture) {
          state.isLogoTexture = false;
          releaseDecalSlot("logo");
        } else {
          state.isLogoTexture = true;
          beginDecalRequest("logo", state.logoDecal);
        }
        break;

      // full texture tab
      case "stylishShirt":
        if (state.isFullTexture) {
          state.isFullTexture = false;
          releaseDecalSlot("full");
        } else {
          state.isFullTexture = true;
          beginDecalRequest("full", state.fullDecal);
        }
        break;

      default:
        state.isLogoTexture = true;
        state.isFullTexture = false;
        releaseDecalSlot("full");
        beginDecalRequest("logo", state.logoDecal);
    }
  };

  // handle decals
  const handleDecals = (type: DecalKey, result: string) => {
    // current decal type
    const decalType = DecalTypes[type];
    const slot: DecalSlot = type;

    // only the latest request may settle, so rapid switches keep the last one
    beginDecalRequest(slot, result);

    // if the decal is hidden, turning it on starts the request for the
    // source just stored above. Read live state: this may run from an async
    // callback after the last render.
    if (!state[decalEnabledProperty(slot)]) {
      handleActiveFilterTab(decalType.filterTab);
    }
  };

  // read file from input
  const readFile = (type: DecalKey) => {
    if (!file) return;

    reader(file)
      .then((result) => {
        handleDecals(type, result);
        setFile(null);
        setActiveEditorTab("");
      })
      .catch((error: unknown) => {
        // Keep the current decal; the old texture stays referenced.
        console.warn("Failed to read decal file", error);
        setDownloadError(
          "Could not read that image. Your current decal is unchanged.",
        );
      });
  };

  // handle input submit
  const handleSubmit = async (type: DecalKey): Promise<GenerateResult> => {
    if (!prompt.trim()) {
      return { ok: false, message: "Please enter a prompt" };
    }

    try {
      // set loading to true
      setGeneratingImg(true);

      // fetch dalle api response
      const response = await fetch("/api/v1/dalle", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          type,
        }),
      });

      let data: DalleSuccessResponse | DalleErrorResponse;
      try {
        data = (await response.json()) as
          | DalleSuccessResponse
          | DalleErrorResponse;
      } catch {
        return {
          ok: false,
          message:
            response.status === 404
              ? "AI generation needs the full app server. Run netlify-cli dev."
              : "Failed to generate image. Please try again.",
        };
      }

      if (!response.ok || !("photo" in data) || !data.photo) {
        const message =
          "message" in data ? data.message : "Failed to generate image";
        const needsApiKey =
          "code" in data && data.code === "invalid_api_key";

        return { ok: false, message, needsApiKey };
      }

      // handle decals
      handleDecals(type, `data:image/png;base64,${data.photo}`);
      setActiveEditorTab("");
      setPrompt("");
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to generate image";
      return { ok: false, message };
    } finally {
      // set loading to false
      setGeneratingImg(false);
    }
  };

  // capture the current canvas, but only when decals are fully applied
  const handleDownload = async () => {
    const readiness = getDownloadReadiness(state);
    if (!readiness.ready) {
      setDownloadError(readiness.message);
      return;
    }

    setDownloadError("");
    setDownloading(true);

    try {
      await prepareCanvasSnapshot();
      // Re-check after the frame settles: a texture switch could have
      // started while waiting, and we must never capture a stale decal.
      const settled = getDownloadReadiness(state);
      if (!settled.ready) {
        setDownloadError(settled.message);
        return;
      }
      captureCanvasToImage();
    } catch (error) {
      console.warn("Failed to download canvas", error);
      setDownloadError("Could not capture the shirt. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  // clear transient hints once the scene is ready again, and retire decal
  // errors after they have been shown (the original decal stays in place).
  useEffect(() => {
    if (downloadState.ready && downloadError) setDownloadError("");
  }, [downloadState.ready, downloadError]);

  useEffect(() => {
    if (!decalError) return;
    const timer = setTimeout(() => {
      (["logo", "full"] as DecalSlot[]).forEach((slot) => {
        if (state.decalStatus[slot].error) clearDecalError(slot);
      });
    }, 6000);
    return () => clearTimeout(timer);
  }, [decalError]);

  // show tab content depending on the active tab
  const generateTabContent = () => {
    switch (activeEditorTab) {
      // color picker
      case "colorpicker":
        return <ColorPicker />;

      // file picker
      case "filepicker":
        return <FilePicker file={file} setFile={setFile} readFile={readFile} />;

      // ai picker
      case "aipicker":
        return (
          <AIPicker
            prompt={prompt}
            setPrompt={setPrompt}
            generatingImg={generatingImg}
            handleSubmit={handleSubmit}
          />
        );

      default:
        return null;
    }
  };

  return (
    <HelmetProvider>
      <AnimatePresence>
        {/* show only if not on home page */}
        {!snap.intro && (
          <>
            {/* change headers */}
            <Helmet>
              <title>3D T-Shirt Customizer</title>
              <meta
                name="theme-color"
                media="(prefers-color-scheme: dark)"
                content={snap.color}
              />
            </Helmet>

            {/* editor tabs */}
            <motion.div
              key="custom"
              className="absolute top-0 left-0 z-10"
              {...slideAnimation("left")}
            >
              <div className="flex items-center min-h-screen">
                <div className="editortabs-container tabs">
                  {EditorTabs.map((tab) => (
                    <Tab
                      key={tab.name}
                      tab={tab}
                      handleClick={() => setActiveEditorTab(tab.name)}
                    />
                  ))}

                  {/* tab contents and toggle */}
                  {generateTabContent()}
                </div>
              </div>
            </motion.div>

            {/* Go Back Button */}
            <motion.div
              className="absolute z-10 top-5 right-5"
              {...fadeAnimation}
            >
              <CustomButton
                type="filled"
                title="Go Back"
                handleClick={() => (state.intro = true)}
                customStyles="w-fit px-4 py-2.5 font-bold text-sm"
              />
            </motion.div>

            {/* filter tabs */}
            <motion.div
              className="filtertabs-container"
              {...slideAnimation("up")}
            >
              {FilterTabs.map((tab) => (
                <Tab
                  key={tab.name}
                  tab={tab}
                  isFilterTab
                  isActiveTab={activeFilterTab[tab.name]}
                  handleClick={() => handleActiveFilterTab(tab.name)}
                />
              ))}

              {/* Download button */}
              <button
                className="download-btn disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleDownload}
                disabled={!downloadState.ready || downloading}
                aria-busy={downloading}
                aria-disabled={!downloadState.ready || downloading}
                title={downloadState.ready ? "Download" : downloadState.message}
              >
                <img
                  src={download}
                  alt="download_image"
                  className="w-3/5 h-3/5 object-contain"
                />
              </button>

              {/* live status for the download/decal pipeline */}
              <span
                role="status"
                aria-live="polite"
                className={`pointer-events-none absolute -top-8 right-0 w-max max-w-[240px] rounded-md bg-black/70 px-2 py-1 text-center text-[11px] leading-snug text-white transition-opacity ${
                  statusNotice ? "opacity-100" : "opacity-0"
                }`}
              >
                {statusNotice}
              </span>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </HelmetProvider>
  );
};

export default Customizer;
