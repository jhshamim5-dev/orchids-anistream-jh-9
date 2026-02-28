import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Maximize, Minimize, AlertCircle, SkipForward, Play, Pause, Volume2, VolumeX, Settings, Server, Captions, CaptionsOff, RotateCcw, RotateCw, Gauge } from 'lucide-react';
import { useAnimeDetails, useAnimeEpisodes } from '@/hooks/useAnime';
import { useWatchHistory } from '@/hooks/useWatchHistory';
import { WatchHistoryEntry } from '@/lib/db';
import { Slider } from '@/components/ui/slider';
import Artplayer from 'artplayer';
import Hls from 'hls.js';

const API_BASE = 'https://animeapi-sage.vercel.app';
const CORS_PROXY = '/__proxy/hls?b64=';

const encodeProxyTarget = (url: string) => {
  const bytes = new TextEncoder().encode(url);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const buildProxyUrl = (url: string) => `${CORS_PROXY}${encodeProxyTarget(url)}`;

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface StreamServer {
  type: string;
  data_id: string;
  server_id: string;
  serverName: string;
}

interface StreamTrack {
  file: string;
  label: string;
  kind: string;
  default?: boolean;
}

interface StreamData {
  streamingLink: {
    id: string;
    type: string;
    link: {
      file: string;
      type: string;
    };
    tracks: StreamTrack[];
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
    server: string;
  };
  servers: StreamServer[];
}

const VideoPlayer = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const hlsInstanceRef = useRef<Hls | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [qualityLevels, setQualityLevels] = useState<{ height: number; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [showPlaybackSpeedMenu, setShowPlaybackSpeedMenu] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<'forward' | 'backward' | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);
  const [servers, setServers] = useState<StreamServer[]>([]);
  const [currentServer, setCurrentServer] = useState('hd-2');
  const [streamData, setStreamData] = useState<StreamData | null>(null);
  const [subtitles, setSubtitles] = useState<StreamTrack[]>([]);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  const [introOutro, setIntroOutro] = useState<{ intro?: { start: number; end: number }; outro?: { start: number; end: number } }>({});
    const introOutroRef = useRef<{ intro?: { start: number; end: number }; outro?: { start: number; end: number } }>({});
    const [showSkipIntro, setShowSkipIntro] = useState(false);
    const [showSkipOutro, setShowSkipOutro] = useState(false);
  const [savedProgress, setSavedProgress] = useState<WatchHistoryEntry | null>(null);
  const [progressLoaded, setProgressLoaded] = useState(false);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDraggingRef = useRef(false);

  const { saveProgress, getEpisodeProgress } = useWatchHistory();
  const { data: anime } = useAnimeDetails(id!);
  const { data: episodesData } = useAnimeEpisodes(id!);

  const triggerSeekFeedback = (direction: 'forward' | 'backward') => {
    if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
    setSeekFeedback(direction);
    seekTimeoutRef.current = setTimeout(() => setSeekFeedback(null), 600);
  };

  const epId = searchParams.get('epId');
  const episode = parseInt(searchParams.get('ep') || '1', 10);
  const audioType = (searchParams.get('audio') || 'sub') as 'sub' | 'dub';

  const totalEpisodes = episodesData?.totalEpisodes || anime?.episodes || 12;
  const hasNextEpisode = episode < totalEpisodes;

  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [isPlaying]);

  const toggleControls = useCallback(() => {
    setShowControls(prev => !prev);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
  }, []);

  const togglePlay = useCallback(() => {
    const art = artRef.current;
    if (!art) return;
    if (art.playing) {
      art.pause();
      setIsPlaying(false);
    } else {
      art.play();
      setIsPlaying(true);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const art = artRef.current;
    if (!art) return;
    art.muted = !art.muted;
    setIsMuted(art.muted);
  }, []);

  const handleVolumeChange = (newVolume: number[]) => {
    const art = artRef.current;
    if (!art) return;
    const val = newVolume[0];
    art.volume = val;
    setVolume(val);
    if (val > 0) {
      art.muted = false;
      setIsMuted(false);
    }
  };

  const skipForward = useCallback(() => {
    const art = artRef.current;
    if (!art) return;
    art.currentTime = Math.min(art.currentTime + 10, art.duration);
    triggerSeekFeedback('forward');
  }, []);

  const skipBackward = useCallback(() => {
    const art = artRef.current;
    if (!art) return;
    art.currentTime = Math.max(art.currentTime - 10, 0);
    triggerSeekFeedback('backward');
  }, []);

  const changePlaybackSpeed = (speed: number) => {
    const art = artRef.current;
    if (!art) return;
    art.playbackRate = speed;
    setPlaybackSpeed(speed);
    setShowPlaybackSpeedMenu(false);
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await containerRef.current.requestFullscreen();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      resetControlsTimeout();

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'arrowright':
          e.preventDefault();
          skipForward();
          break;
        case 'arrowleft':
          e.preventDefault();
          skipBackward();
          break;
        case 'arrowup':
          e.preventDefault();
          handleVolumeChange([Math.min(volume + 0.1, 1)]);
          break;
        case 'arrowdown':
          e.preventDefault();
          handleVolumeChange([Math.max(volume - 0.1, 0)]);
          break;
        case 'j':
          e.preventDefault();
          skipBackward();
          break;
        case 'l':
          e.preventDefault();
          skipForward();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, toggleMute, skipForward, skipBackward, volume]);

  const lastTapRef = useRef<number>(0);
    const singleTapTimerRef = useRef<NodeJS.Timeout | null>(null);

    const handleDoubleTap = (side: 'left' | 'right' | 'center') => {
      const now = Date.now();
      const diff = now - lastTapRef.current;

      if (diff < 300) {
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        if (side === 'left') skipBackward();
        else if (side === 'right') skipForward();
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
        singleTapTimerRef.current = setTimeout(() => {
          toggleControls();
          singleTapTimerRef.current = null;
        }, 300);
      }
    };

  const doSaveProgress = useCallback(async () => {
    if (!id || !episode || !epId || !anime || durationRef.current <= 0) return;

    await saveProgress({
      animeId: id,
      animeTitle: anime.title.english || anime.title.romaji,
      animeCover: anime.coverImage.extraLarge || anime.coverImage.large,
      episode,
      epId,
      timestamp: currentTimeRef.current,
      duration: durationRef.current,
      audioType,
      updatedAt: Date.now(),
      totalEpisodes
    });
  }, [id, episode, epId, anime, audioType, totalEpisodes, saveProgress]);

  useEffect(() => {
    const loadSavedProgress = async () => {
      if (id && episode) {
        const progress = await getEpisodeProgress(id, episode);
        setSavedProgress(progress);
        setProgressLoaded(true);
      }
    };
    loadSavedProgress();
  }, [id, episode, getEpisodeProgress]);

  const fetchStream = useCallback(async (server: string, type: string) => {
    if (!epId) return;

    setIsLoading(true);
    setError(null);

    try {
      const streamUrl = `${API_BASE}/api/stream?id=${epId}&server=${server}&type=${type}`;
      const res = await fetch(streamUrl);
      const json = await res.json();

      if (!json.success || !json.results?.streamingLink) {
        throw new Error('Failed to fetch stream');
      }

      setStreamData(json.results);
      setServers(json.results.servers || []);
      setSubtitles(json.results.streamingLink.tracks || []);
        const io = {
          intro: json.results.streamingLink.intro,
          outro: json.results.streamingLink.outro,
        };
        setIntroOutro(io);
        introOutroRef.current = io;

      return json.results.streamingLink.link.file;
    } catch (err) {
      setError('Failed to load stream. Try another server.');
      setIsLoading(false);
      return null;
    }
  }, [epId]);

  useEffect(() => {
    if (!playerContainerRef.current || !epId || !progressLoaded) return;

    let mounted = true;

    const initPlayer = async () => {
      const streamUrl = await fetchStream(currentServer, audioType);
      if (!streamUrl || !mounted) return;

      if (artRef.current) {
        artRef.current.destroy();
        artRef.current = null;
      }
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }

      const art = new Artplayer({
        container: playerContainerRef.current!,
        url: streamUrl,
        type: 'm3u8',
        volume: volume,
        muted: isMuted,
        autoplay: true,
        pip: false,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: false,
        loop: false,
        flip: false,
        playbackRate: false,
        aspectRatio: false,
        fullscreen: false,
        fullscreenWeb: false,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        backdrop: false,
        playsInline: true,
        autoPlayback: false,
        theme: 'hsl(var(--primary))',
        cssVar: {},
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
                if (Hls.isSupported()) {
                  const proxiedUrl = buildProxyUrl(url);
                    const hls = new Hls({
                      enableWorker: true,
                      lowLatencyMode: false,
                      maxBufferLength: 60,
                      maxMaxBufferLength: 120,
                      maxBufferSize: 60 * 1000 * 1000,
                      maxBufferHole: 0.5,
                      highBufferWatchdogPeriod: 2,
                      nudgeOffset: 0.1,
                      nudgeMaxRetry: 5,
                      startLevel: -1,
                      autoStartLoad: true,
                      backBufferLength: 30,
                      abrEwmaDefaultEstimate: 5000000,
                      abrEwmaFastLive: 3,
                      abrEwmaSlowLive: 9,
                      abrEwmaFastVoD: 3,
                      abrEwmaSlowVoD: 9,
                      fragLoadingTimeOut: 20000,
                      fragLoadingMaxRetry: 6,
                      fragLoadingRetryDelay: 1000,
                      levelLoadingTimeOut: 10000,
                      levelLoadingMaxRetry: 4,
                    xhrSetup: (xhr: XMLHttpRequest, xhrUrl: string) => {
                      const finalUrl = xhrUrl.startsWith(CORS_PROXY) ? xhrUrl : buildProxyUrl(xhrUrl);
                      xhr.open('GET', finalUrl, true);
                    },
                  });

                  hlsInstanceRef.current = hls;
                  hls.loadSource(proxiedUrl);
                hls.attachMedia(video);

                hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                  if (!mounted) return;
                  const levels = data.levels.map((level, index) => ({
                    height: level.height,
                    index,
                  }));
                  setQualityLevels(levels);

                  const target1080 = levels.find(l => l.height === 1080);
                  if (target1080) {
                    hls.currentLevel = target1080.index;
                    setCurrentQuality(target1080.index);
                  } else if (levels.length > 0) {
                    const highest = levels.reduce((a, b) => a.height > b.height ? a : b);
                    hls.currentLevel = highest.index;
                    setCurrentQuality(highest.index);
                  }
                });

                hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                  if (!mounted) return;
                  setCurrentQuality(data.level);
                });

                hls.on(Hls.Events.ERROR, (_, data) => {
                  if (data.fatal && mounted) {
                    setError('Playback error. Try another server.');
                    setIsLoading(false);
                  }
                });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                  video.src = buildProxyUrl(url);
                }
            },
          },
      });

      artRef.current = art;

    art.on('ready', () => {
          if (!mounted) return;
          setIsLoading(false);
          if (savedProgress && savedProgress.timestamp > 10) {
            art.currentTime = savedProgress.timestamp;
          }
        });

      art.on('play', () => {
        if (!mounted) return;
        setIsPlaying(true);
      });

      art.on('pause', () => {
        if (!mounted) return;
        setIsPlaying(false);
        if (durationRef.current > 0 && currentTimeRef.current > 10) {
          doSaveProgress();
        }
      });

      art.on('video:timeupdate', () => {
          if (!mounted || isDraggingRef.current) return;
          setCurrentTime(art.currentTime);
          currentTimeRef.current = art.currentTime;
          setDuration(art.duration);
          durationRef.current = art.duration;

          const io = introOutroRef.current;
          if (io.intro) {
            setShowSkipIntro(art.currentTime >= io.intro.start && art.currentTime <= io.intro.end);
          }
          if (io.outro) {
            setShowSkipOutro(art.currentTime >= io.outro.start && art.currentTime <= io.outro.end);
          }
        });

      art.on('video:waiting', () => {
        if (!mounted) return;
        setIsLoading(true);
      });

      art.on('video:playing', () => {
        if (!mounted) return;
        setIsPlaying(true);
        setIsLoading(false);
      });

      art.on('video:canplay', () => {
        if (!mounted) return;
        setIsLoading(false);
      });

      art.on('video:progress', () => {
        if (!mounted) return;
        const video = art.video;
        if (video.buffered.length > 0) {
          setBuffered(video.buffered.end(video.buffered.length - 1));
        }
      });
    };

    initPlayer();

    return () => {
      mounted = false;
      if (artRef.current) {
        artRef.current.destroy();
        artRef.current = null;
      }
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    };
  }, [epId, currentServer, audioType, fetchStream, progressLoaded]);

  useEffect(() => {
    if (!id || !episode) return;

    const interval = setInterval(() => {
      if (durationRef.current > 0) {
        doSaveProgress();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [id, episode, doSaveProgress]);

  const [forceRotate, setForceRotate] = useState(false);

  const isPortrait = useCallback(() => {
    return window.innerHeight > window.innerWidth;
  }, []);

  const lockToLandscape = useCallback(async () => {
    try {
      if (screen.orientation && 'lock' in screen.orientation) {
        await (screen.orientation as any).lock('landscape');
        setForceRotate(false);
        return true;
      }
    } catch {}

    if (isPortrait()) {
      setForceRotate(true);
    }
    return false;
  }, [isPortrait]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(isFs);

      if (isFs) {
        lockToLandscape();
      } else {
        setForceRotate(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, [lockToLandscape]);

  useEffect(() => {
    const enterFullscreenLandscape = async () => {
      if (document.fullscreenElement || (document as any).webkitFullscreenElement) return;

      const elem = containerRef.current as any;

      try {
        if (elem?.requestFullscreen) {
          await elem.requestFullscreen();
        } else if (elem?.webkitRequestFullscreen) {
          await elem.webkitRequestFullscreen();
        }
        await lockToLandscape();
      } catch {}
    };

    const timer = setTimeout(() => {
      enterFullscreenLandscape();
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [lockToLandscape]);

  const handleSeekValueChange = (val: number[]) => {
    const time = val[0];
    setCurrentTime(time);
    if (artRef.current && isDragging) {
      artRef.current.currentTime = time;
    }
  };

  const handleSeekStart = () => {
    setIsDragging(true);
    isDraggingRef.current = true;
  };

  const handleSeekEnd = (val: number[]) => {
    setIsDragging(false);
    isDraggingRef.current = false;
    if (artRef.current) {
      artRef.current.currentTime = val[0];
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = e.currentTarget;
    if (!bar || duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    setHoverTime(percent * duration);
    setHoverX(x);
  };

  const handleBack = async () => {
    await doSaveProgress();

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }

    try {
      await screen.orientation.unlock();
    } catch {}

    if (artRef.current) {
      artRef.current.destroy();
      artRef.current = null;
    }
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.destroy();
      hlsInstanceRef.current = null;
    }

    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(`/anime/${id}/episodes`);
    }
  };

  const handleNextEpisode = useCallback(() => {
    if (!hasNextEpisode || !episodesData) return;
    const nextEpNum = episode + 1;
    const nextEp = episodesData.episodes.find(e => e.episode_no === nextEpNum);
    if (nextEp) {
      navigate(`/watch/${id}?epId=${encodeURIComponent(nextEp.id)}&ep=${nextEpNum}&audio=${audioType}`, { replace: true });
    }
  }, [episode, hasNextEpisode, id, audioType, navigate, episodesData]);

  const handlePreviousEpisode = useCallback(() => {
    if (episode <= 1 || !episodesData) return;
    const prevEpNum = episode - 1;
    const prevEp = episodesData.episodes.find(e => e.episode_no === prevEpNum);
    if (prevEp) {
      navigate(`/watch/${id}?epId=${encodeURIComponent(prevEp.id)}&ep=${prevEpNum}&audio=${audioType}`, { replace: true });
    }
  }, [episode, id, audioType, navigate, episodesData]);

  const setQuality = (levelIndex: number) => {
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.currentLevel = levelIndex;
    }
    setShowQualityMenu(false);
  };

  const changeServer = (server: StreamServer) => {
    setCurrentServer(server.serverName.toLowerCase());
    setShowServerMenu(false);
  };

  const skipIntro = () => {
    const art = artRef.current;
    if (art && introOutro.intro) {
      art.currentTime = introOutro.intro.end;
    }
  };

  const skipOutro = () => {
    const art = artRef.current;
    if (art && introOutro.outro) {
      art.currentTime = introOutro.outro.end;
    }
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const changeSubtitle = (track: StreamTrack | null) => {
    const art = artRef.current;
    if (!art) return;

    if (track) {
      setCurrentSubtitle(track.label);
      art.subtitle.url = track.file;
      art.subtitle.show = true;
    } else {
      setCurrentSubtitle(null);
      art.subtitle.show = false;
    }
    setShowSubtitleMenu(false);
  };

  const filteredServers = servers.filter(s => s.type === audioType);

  if (error && !streamData) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center p-6">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Playback Error</h2>
          <p className="text-gray-400 mb-4">{error}</p>
          <button onClick={() => navigate(-1)} className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-semibold">
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black overflow-hidden select-none"
      style={forceRotate ? {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vh',
        height: '100vw',
        transform: 'rotate(90deg)',
        transformOrigin: 'top left',
        marginLeft: '100vw',
      } : {
        width: '100vw',
        height: '100vh',
      }}
      onMouseMove={resetControlsTimeout}
    >
      <div
        ref={playerContainerRef}
        className="absolute inset-0 w-full h-full z-0"
      />

      <style>{`
        .art-video-player {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          z-index: 0 !important;
        }
        .art-video-player .art-bottom,
        .art-video-player .art-top,
        .art-video-player .art-mask,
        .art-video-player .art-loading,
        .art-video-player .art-notice,
        .art-video-player .art-contextmenu,
        .art-video-player .art-info,
        .art-video-player .art-subtitle {
          display: none !important;
        }
        .art-video-player video {
          object-fit: contain !important;
        }
      `}</style>

      <div className="absolute inset-0 z-10 flex pointer-events-none">
          <div className="flex-1 pointer-events-auto" onClick={() => handleDoubleTap('left')} />
          <div className="w-1/3 pointer-events-auto" onClick={() => handleDoubleTap('center')} />
          <div className="flex-1 pointer-events-auto" onClick={() => handleDoubleTap('right')} />
        </div>

        <AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-20 pointer-events-none"
            >
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-white/10 border-t-primary animate-spin" />
              </div>
              <p className="mt-4 text-sm text-white/60 font-medium">Loading...</p>
            </motion.div>
          )}
        </AnimatePresence>

      <AnimatePresence>
        {seekFeedback && (
          <motion.div
            key={seekFeedback}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.5 }}
            className={`absolute top-1/2 -translate-y-1/2 z-50 flex flex-col items-center gap-4 pointer-events-none ${
              seekFeedback === 'backward' ? 'left-1/4' : 'right-1/4'
            }`}
          >
            <div className="relative flex items-center justify-center">
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: [1, 2], opacity: [0.5, 0] }}
                transition={{ duration: 0.6, repeat: Infinity }}
                className="absolute inset-0 bg-white rounded-full blur-xl"
              />
              <div className="w-24 h-24 rounded-full bg-black/60 backdrop-blur-xl flex flex-col items-center justify-center border-2 border-white/30 shadow-2xl relative overflow-hidden">
                {seekFeedback === 'backward' ? (
                  <div className="relative flex flex-col items-center">
                    <RotateCcw className="w-12 h-12 text-white" />
                    <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-black text-white mt-1">10</span>
                  </div>
                ) : (
                  <div className="relative flex flex-col items-center">
                    <RotateCw className="w-12 h-12 text-white" />
                    <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-black text-white mt-1">10</span>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSkipIntro && (
          <motion.button
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            onClick={skipIntro}
            className="absolute bottom-24 right-4 px-6 py-3 bg-white text-black font-bold rounded-lg z-30 hover:bg-gray-200 transition-colors shadow-xl pointer-events-auto"
          >
            Skip Intro
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSkipOutro && (
          <motion.button
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            onClick={skipOutro}
            className="absolute bottom-24 right-4 px-6 py-3 bg-white text-black font-bold rounded-lg z-30 hover:bg-gray-200 transition-colors shadow-xl pointer-events-auto"
          >
            Skip Outro
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 1 }}
        animate={{ opacity: showControls ? 1 : 0 }}
        transition={{ duration: 0.3 }}
        className="absolute inset-0 z-30 flex flex-col pointer-events-none"
      >
        <div className="p-4 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent pointer-events-auto h-24">
          <div className="flex items-center gap-4">
            <button onClick={(e) => { e.stopPropagation(); handleBack(); }} className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center hover:bg-white/10 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex flex-col">
              <h1 className="text-sm font-bold truncate max-w-[200px] md:max-w-md">{anime?.title.english || anime?.title.romaji}</h1>
              <p className="text-xs text-gray-300">Episode {episode} / {totalEpisodes}</p>
            </div>
          </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowServerMenu(!showServerMenu); setShowQualityMenu(false); setShowSubtitleMenu(false); setShowPlaybackSpeedMenu(false); }}
                  className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center hover:bg-white/10 transition-colors"
                >
                  <Server className="w-5 h-5" />
                </button>
                {showServerMenu && filteredServers.length > 0 && (
                  <div className="absolute right-0 top-12 bg-black/95 rounded-lg overflow-hidden min-w-[140px] border border-white/10 shadow-2xl">
                    <div className="px-3 py-2 text-xs text-gray-400 border-b border-white/10 uppercase tracking-wider font-bold">Servers</div>
                    {filteredServers.map((server) => (
                      <button
                        key={server.data_id}
                        onClick={(e) => { e.stopPropagation(); changeServer(server); }}
                        className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${
                          currentServer === server.serverName.toLowerCase() ? 'text-primary bg-white/5' : ''
                        }`}
                      >
                        {server.serverName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); setShowServerMenu(false); setShowSubtitleMenu(false); setShowPlaybackSpeedMenu(false); }}
                  className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center hover:bg-white/10 transition-colors"
                >
                  <Settings className="w-5 h-5" />
                </button>
              {showQualityMenu && qualityLevels.length > 0 && (
                <div className="absolute right-0 top-12 bg-black/95 rounded-lg overflow-hidden min-w-[120px] border border-white/10 shadow-2xl">
                  <div className="px-3 py-2 text-xs text-gray-400 border-b border-white/10 uppercase tracking-wider font-bold">Quality</div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setQuality(-1); }}
                    className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${currentQuality === -1 ? 'text-primary bg-white/5' : ''}`}
                  >
                    Auto
                  </button>
                  {qualityLevels.map((level) => (
                    <button
                      key={level.index}
                      onClick={(e) => { e.stopPropagation(); setQuality(level.index); }}
                      className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${currentQuality === level.index ? 'text-primary bg-white/5' : ''}`}
                    >
                      {level.height}p
                    </button>
                  ))}
                </div>
                )}
              </div>
              <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center hover:bg-white/10 transition-colors">
                {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center gap-12 pointer-events-none">
          <button
            onClick={(e) => { e.stopPropagation(); handlePreviousEpisode(); }}
            disabled={episode <= 1}
            className="w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-30 hover:bg-white/10 transition-all pointer-events-auto hover:scale-110 active:scale-95"
          >
            <SkipForward className="w-8 h-8 rotate-180 fill-white" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="w-24 h-24 rounded-full bg-primary flex items-center justify-center hover:bg-primary/90 transition-all pointer-events-auto hover:scale-110 active:scale-90 shadow-2xl">
            {isPlaying ? <Pause className="w-12 h-12 fill-primary-foreground" /> : <Play className="w-12 h-12 ml-1 fill-primary-foreground" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleNextEpisode(); }}
            disabled={!hasNextEpisode}
            className="w-14 h-14 rounded-full flex items-center justify-center disabled:opacity-30 hover:bg-white/10 transition-all pointer-events-auto hover:scale-110 active:scale-95"
          >
            <SkipForward className="w-8 h-8 fill-white" />
          </button>
        </div>

        <div className="p-6 bg-gradient-to-t from-black/80 to-transparent pointer-events-auto">
          <div className="relative flex flex-col gap-4">
            <style>{`
              .video-slider [data-orientation="horizontal"] {
                height: 6px;
              }
              .video-slider [data-radix-collection-item] {
                width: 14px;
                height: 14px;
                background-color: var(--primary);
                border: none;
                box-shadow: 0 0 10px rgba(0,0,0,0.5);
                cursor: pointer;
                transition: transform 0.1s ease;
              }
              .video-slider:hover [data-radix-collection-item] {
                transform: scale(1.2);
              }
            `}</style>

            <div
              className="relative group/progress video-slider"
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoverTime(null)}
            >
              <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 bg-white/10 rounded-full overflow-hidden pointer-events-none">
                <div
                  className="h-full bg-white/20 transition-all duration-300"
                  style={{ width: `${(buffered / duration) * 100}%` }}
                />
              </div>

              <Slider
                value={[currentTime]}
                max={duration}
                step={0.1}
                onValueChange={handleSeekValueChange}
                onPointerDown={handleSeekStart}
                onValueCommit={handleSeekEnd}
                className="relative z-10 cursor-pointer"
              />

              {hoverTime !== null && (
                <div
                  className="absolute bottom-6 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none"
                  style={{ left: hoverX }}
                >
                  <div className="bg-black/90 px-2 py-1 rounded text-xs font-bold border border-white/10">
                    {formatTime(hoverTime)}
                  </div>
                  <div className="w-px h-2 bg-white/30" />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="flex items-center group/volume">
                  <button onClick={(e) => { e.stopPropagation(); toggleMute(); }} className="w-10 h-10 rounded-full hover:bg-white/10 transition-colors flex items-center justify-center">
                    {isMuted || volume === 0 ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
                  </button>
                  <div className="w-0 overflow-hidden group-hover/volume:w-24 transition-all duration-300 flex items-center px-2">
                    <Slider
                      value={[volume]}
                      min={0}
                      max={1}
                      step={0.01}
                      onValueChange={handleVolumeChange}
                      className="w-20"
                    />
                  </div>
                </div>
                <span className="text-sm font-bold tabular-nums tracking-wider">{formatTime(currentTime)} <span className="text-white/20">/</span> {formatTime(duration)}</span>
              </div>

                <div className="flex items-center gap-4">
                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowPlaybackSpeedMenu(!showPlaybackSpeedMenu); setShowQualityMenu(false); setShowServerMenu(false); setShowSubtitleMenu(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors text-sm font-bold"
                    >
                      <Gauge className="w-4 h-4 text-primary" />
                      {playbackSpeed === 1 ? 'Normal' : `${playbackSpeed}x`}
                    </button>
                    {showPlaybackSpeedMenu && (
                      <div className="absolute right-0 bottom-full mb-2 bg-black/95 rounded-lg overflow-hidden min-w-[100px] border border-white/10 shadow-2xl">
                        <div className="px-3 py-2 text-xs text-gray-400 border-b border-white/10 uppercase tracking-wider font-bold">Speed</div>
                        {PLAYBACK_SPEEDS.map((speed) => (
                          <button
                            key={speed}
                            onClick={(e) => { e.stopPropagation(); changePlaybackSpeed(speed); }}
                            className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${
                              playbackSpeed === speed ? 'text-primary bg-white/5' : ''
                            }`}
                          >
                            {speed}x
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowSubtitleMenu(!showSubtitleMenu); setShowQualityMenu(false); setShowServerMenu(false); setShowPlaybackSpeedMenu(false); }}
                      className="w-10 h-10 rounded-full hover:bg-white/10 transition-colors flex items-center justify-center"
                    >
                      {currentSubtitle ? <Captions className="w-5 h-5" /> : <CaptionsOff className="w-5 h-5" />}
                    </button>
                    {showSubtitleMenu && (
                      <div className="absolute right-0 bottom-full mb-2 bg-black/95 rounded-lg overflow-hidden min-w-[160px] border border-white/10 shadow-2xl max-h-[300px] overflow-y-auto">
                        <div className="px-3 py-2 text-xs text-gray-400 border-b border-white/10 uppercase tracking-wider font-bold">Subtitles</div>
                        <button
                          onClick={(e) => { e.stopPropagation(); changeSubtitle(null); }}
                          className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${!currentSubtitle ? 'text-primary bg-white/5' : ''}`}
                        >
                          Off
                        </button>
                        {subtitles.filter(t => t.kind === 'captions').map((track, i) => (
                          <button
                            key={i}
                            onClick={(e) => { e.stopPropagation(); changeSubtitle(track); }}
                            className={`w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${currentSubtitle === track.label ? 'text-primary bg-white/5' : ''}`}
                          >
                            {track.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default VideoPlayer;
