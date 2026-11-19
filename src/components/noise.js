import * as Tone from 'tone'

export default {
  name: 'Noise',

  data: () => ({
    mainPlayLoading: true,
    isTimerValid: false,
    selectedProfile: {},
    profileItems: [],
    profileDialog: false,
    profileName: '',
    isProfileValid: false,
    profileMoreDialog: false,
    importDialog: false,
    isImportValid: false,
    exportDialog: false,
    importedProfile: null,
    importedProfileName: '',
    exportedProfile: {},
    infoSnackbar: false,
    infoSnackbarText: '',
    playDisabled: false,
    isTimerEnabled: false,
    hours: 0,
    minutes: 0,
    seconds: 30,
    duration: 30,
    timeRemaining: 0,
    noiseColor: 'pink',
    noiseColorItems: ['pink', 'white', 'brown'],
    volume: -10,
    isFilterEnabled: false,
    filterCutoff: 1000,
    filterType: 'lowpass',
    filterTypeItems: ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'notch', 'allpass', 'peaking'],
    isLFOFilterCutoffEnabled: false,
    lfoFilterCutoffFrequency: 0.5,
    lfoFilterCutoffMin: 0,
    lfoFilterCutoffMax: 5000,
    lfoFilterCutoffRange: [100, 5000],
    isTremoloEnabled: false,
    tremoloFrequency: 0.5,
    tremoloDepth: 0.5,
    isReverbEnabled: false,
    allSamples: [],
    loadedSamples: [],
    selectedSample: null,
    uploadSampleDialog: false,
    addSampleDialog: false,
    checkedSamples: [],
    sampleName: '',
    isSampleUploadValid: false,
    canUpload: false,
    editSampleDialog: false,
    previewSampleLoopPointsEnabled: false,
    previewSampleLoopStart: 0,
    previewSampleLoopEnd: 0,
    previewSampleFadeIn: 0,
    previewSamplePlaying: false,
    selectedPreviewSample: {},
    previewSampleItems: [],
    isEditSampleValid: false,
    previewSampleButtonText: 'Preview Sample',
    previewSampleLoading: true,
    previewSampleLength: 0,
    startRecordingDialog: false,
    recordingDialog: false,
    recordingTimeElapsed: 0,
    recordedProfile: {},
    recordingFileName: '',
    isRecordingValid: false,
    unsavedWork: false,
    saveProfileText: 'Save Profile',
    unwatch: null,
    confirmSwitchProfileDialog: false,
    activeProfile: {},
    isSporadicValid: false,
    errorSnackbar: false,
    errorSnackbarText: '',
    // Managed audio-graph lifecycle state. The nodes below are created on every
    // play/record run and fully disposed by releaseAudioChain() on stop, so that
    // repeated play/stop cycles never stack stale nodes or keep old timers alive.
    noise: null,
    filter: null,
    tremolo: null,
    lfo: null,
    sampleReverbs: [],
    transportInterval: null,
    timeRemainingInterval: null,
    recordingInterval: null,
    isRecording: false,
    preRecordingSnapshot: null,
    rules: {
      lt (n) {
        return value => (!isNaN(parseInt(value, 10)) && value < n) || 'Must be less than ' + n
      },
      gt (n) {
        return value => (!isNaN(parseInt(value, 10)) && value > n) || 'Must be greater than ' + n
      },
      required () {
        return value => !!value || 'Required'
      }
    }
  }),
  computed: {
    unloadedSamples: function () {
      const samples = []
      this.allSamples.forEach(s1 => {
        const result = this.loadedSamples.find(s2 => s2.id === s1.id)
        if (!result) {
          samples.push(s1)
        }
      })
      return samples
    },
    changeableSettings: function () {
      const settings = [
        this.isTimerEnabled,
        this.hours,
        this.minutes,
        this.seconds,
        this.volume,
        this.noiseColor,
        this.isFilterEnabled,
        this.filterType,
        this.filterCutoff,
        this.isLFOFilterCutoffEnabled,
        this.lfoFilterCutoffFrequency,
        this.lfoFilterCutoffRange,
        this.isTremoloEnabled,
        this.tremoloDepth,
        this.tremoloFrequency,
        this.isTimerEnabled,
        this.loadedSamples
      ]

      this.loadedSamples.forEach(s => {
        settings.push(s.volume)
        settings.push(s.reverbEnabled)
        settings.push(s.reverbPreDelay)
        settings.push(s.reverbDecay)
        settings.push(s.reverbWet)
        settings.push(s.playbackMode)
        settings.push(s.sporadicMin)
        settings.push(s.sporadicMax)
      })

      return settings
    }
  },
  created () {
    // Pooled, long-lived resources. Per-run graph nodes (noise/filter/tremolo/
    // lfo/reverbs) start as null and are owned by releaseAudioChain().
    this.players = new Tone.Players()
    this.samplePreviewPlayer = new Tone.Player().toDestination()
    this.samplePreviewPlayer.loop = true
    this.recorder = new Tone.Recorder()

    this.populateProfileItems(0)
    this.populatePreviewSampleItems()
    this.getSamples()
    this.getCurrentUser()
  },
  beforeDestroy () {
    // Tear down the active run first (nodes, timers, transport), then release
    // the pooled resources that live for the whole component lifetime.
    this.stop()
    this.disposeNode(this.recorder)
    this.disposeNode(this.samplePreviewPlayer)
    this.disposeNode(this.players)
  },
  methods: {
    // ---------------------------------------------------------------------------
    // Audio-graph lifecycle
    //
    // play(), playProfileForRecording() and stop() all converge on the same
    // acquire/release pair:
    //   - releaseAudioChain() stops and disposes every per-run node (Noise,
    //     Filter, Tremolo, LFO, per-sample Reverb), clears every sporadic/timer
    //     interval and resets the Transport. Pooled Players/Recorder survive.
    //   - buildNoiseChain()/setupSamplePlayers() construct a fresh graph only
    //     after the previous one has been released, so nodes never stack.
    // ---------------------------------------------------------------------------
    disposeNode (node) {
      // Every Tone node used here exposes dispose(); guard anyway so a missing
      // or already-disposed node can never take down the teardown path.
      if (node && typeof node.dispose === 'function') {
        try {
          node.dispose()
        } catch (e) {
          // Disposal is best-effort; the node is being abandoned regardless.
        }
      }
    },
    clearSporadicTimers () {
      this.loadedSamples.forEach(s => {
        clearInterval(s.initialSporadicPlayInterval)
        clearInterval(s.sporadicInterval)
        s.initialSporadicPlayInterval = null
        s.sporadicInterval = null
      })
    },
    releaseAudioChain () {
      // 1. Stop all JS timers (timer-mode countdown + sporadic scheduling).
      clearInterval(this.transportInterval)
      clearInterval(this.timeRemainingInterval)
      this.transportInterval = null
      this.timeRemainingInterval = null
      this.clearSporadicTimers()

      // 2. Stop the Transport and strip everything scheduled onto it, then
      //    reset its position and loop bounds so the next run starts clean.
      Tone.Transport.stop()
      Tone.Transport.cancel()
      Tone.Transport.position = 0
      Tone.Transport.loopStart = 0
      Tone.Transport.loopEnd = '4m'

      // 3. Stop and disconnect the synced sample players, but do NOT dispose
      //    them: they are pooled inside Tone.Players and dispose() would also
      //    dispose the shared AudioBuffer used by the next run.
      this.loadedSamples.forEach(s => {
        const player = this.players.has(s.id) ? this.players.player(s.id) : null
        if (player) {
          try {
            player.unsync()
            player.stop()
          } catch (e) {
            // Player may never have been started; ignore.
          }
          player.disconnect()
          player.toDestination()
        }
      })

      // 4. Dispose of every node created for this run.
      this.disposeNode(this.lfo)
      this.lfo = null
      this.disposeNode(this.tremolo)
      this.tremolo = null
      this.disposeNode(this.filter)
      this.filter = null
      this.sampleReverbs.forEach(reverb => this.disposeNode(reverb))
      this.sampleReverbs = []
      this.disposeNode(this.noise)
      this.noise = null
    },
    // Route an effect/output node either straight to the destination (normal
    // playback) or through the recorder first so it also lands on the recording.
    routeOutput (node) {
      if (this.isRecording) {
        return node.connect(this.recorder).toDestination()
      }
      return node.toDestination()
    },
    buildNoiseChain () {
      if (!this.isFilterEnabled && !this.isTremoloEnabled) {
        this.noise = new Tone.Noise({ volume: this.volume, type: this.noiseColor })
        this.routeOutput(this.noise)
      } else if (!this.isFilterEnabled && this.isTremoloEnabled) {
        this.tremolo = new Tone.Tremolo({ frequency: this.tremoloFrequency, depth: this.tremoloDepth })
        this.routeOutput(this.tremolo)
        this.tremolo.start()
        this.noise = new Tone.Noise({ volume: this.volume, type: this.noiseColor }).connect(this.tremolo)
      } else if (this.isFilterEnabled && !this.isTremoloEnabled) {
        this.filter = new Tone.Filter(this.filterCutoff, this.filterType)
        this.routeOutput(this.filter)
        this.noise = new Tone.Noise({ volume: this.volume, type: this.noiseColor }).connect(this.filter)
      } else {
        this.tremolo = new Tone.Tremolo({ frequency: this.tremoloFrequency, depth: this.tremoloDepth })
        this.routeOutput(this.tremolo)
        this.tremolo.start()
        this.filter = new Tone.Filter(this.filterCutoff, this.filterType).connect(this.tremolo)
        this.noise = new Tone.Noise({ volume: this.volume, type: this.noiseColor }).connect(this.filter)
      }

      // Only attach the LFO when a filter node actually exists for it to drive.
      if (this.isLFOFilterCutoffEnabled && this.filter) {
        this.lfo = new Tone.LFO({ frequency: this.lfoFilterCutoffFrequency, min: this.lfoFilterCutoffRange[0], max: this.lfoFilterCutoffRange[1] })
        this.lfo.connect(this.filter.frequency).start()
      }
    },
    setupSamplePlayers (useTimer, duration) {
      this.loadedSamples.forEach(s => {
        const player = this.players.player(s.id)
        player.loop = true
        player.fadeIn = s.fadeIn
        if (s.loopPointsEnabled) {
          player.setLoopPoints(s.loopStart, s.loopEnd)
        } else {
          player.setLoopPoints(0, player.buffer.duration)
        }
        player.volume.value = s.volume

        // Rebuild this player's routing from scratch.
        player.disconnect()
        if (s.reverbEnabled) {
          const reverb = new Tone.Reverb(s.reverbDecay)
          reverb.set({ preDelay: s.reverbPreDelay, wet: s.reverbWet })
          this.sampleReverbs.push(reverb)
          this.routeOutput(reverb)
          player.connect(reverb)
        } else {
          this.routeOutput(player)
        }

        if (s.playbackMode === 'sporadic') {
          player.loop = false

          const maxInt = parseInt(s.sporadicMax, 10)
          const minInt = parseInt(s.sporadicMin, 10)

          if (minInt <= maxInt) {
            const rand = Math.floor(Math.random() * (maxInt - minInt + 1) + minInt)
            s.initialSporadicPlayInterval = setInterval(() => this.playSporadicSample(s.id), rand * 1000)
          }
        } else {
          player.loop = true
          if (useTimer) {
            player.unsync().sync().start(0).stop(duration)
          } else {
            player.unsync().sync().start(0)
          }
        }
      })
    },
    async play () {
      if (!this.players.loaded) {
        return
      }

      await Tone.start()

      // Release any graph left over from a previous run before building the
      // new one, so repeated play/stop cycles never accumulate nodes/timers.
      this.releaseAudioChain()
      this.isRecording = false

      this.playDisabled = true

      this.buildNoiseChain()

      if (this.isTimerEnabled) {
        this.duration = parseInt((this.hours * 3600)) + parseInt((this.minutes * 60)) + parseInt(this.seconds)
        this.timeRemaining = this.duration
        this.transportInterval = setInterval(() => this.stop(), this.duration * 1000 + 100)
        this.timeRemainingInterval = setInterval(() => this.startTimer(), 1000)
        Tone.Transport.loopEnd = this.duration

        this.noise.sync().start(0).stop(this.duration)
      } else {
        this.noise.sync().start(0)
      }

      this.setupSamplePlayers(this.isTimerEnabled, this.duration)

      Tone.Transport.start('+0.1')
    },
    playSporadicSample (id) {
      const sample = this.loadedSamples.find(s => s.id === id)
      if (!sample) {
        return
      }

      clearInterval(sample.initialSporadicPlayInterval)
      clearInterval(sample.sporadicInterval)

      this.players.player(id).unsync().sync().start()

      const maxInt = parseInt(sample.sporadicMax, 10)
      const minInt = parseInt(sample.sporadicMin, 10)
      sample.playNextTime = Math.floor(Math.random() * (maxInt - minInt + 1) + minInt)

      sample.sporadicInterval = setInterval(() => this.playSporadicSample(id), sample.playNextTime * 1000)
    },
    stop () {
      // Fully converge the current run: nodes disposed, timers cleared,
      // transport reset, recording stopped if one is in progress.
      if (this.isRecording && this.recorder && this.recorder.state === 'started') {
        try {
          this.recorder.stop()
        } catch (e) {
          // Recorder already inactive; nothing to do.
        }
      }
      this.isRecording = false
      clearInterval(this.recordingInterval)
      this.recordingInterval = null

      this.releaseAudioChain()

      this.playDisabled = false
      this.timeRemaining = 0
      this.duration = 0
    },
    startTimer () {
      this.timeRemaining -= 1
    },
    updateVolume () {
      if (this.noise) {
        this.noise.volume.value = this.volume
      }
    },
    updateNoiseColor () {
      if (this.noise) {
        this.noise.type = this.noiseColor
      }
    },
    updateFilterType () {
      if (this.filter) {
        this.filter.type = this.filterType
      }
    },
    updateFilterCutoff () {
      if (this.filter) {
        this.filter.set({ frequency: this.filterCutoff })
      }
    },
    updateLFOFilterCutoffFrequency () {
      if (this.lfo) {
        this.lfo.set({ frequency: this.lfoFilterCutoffFrequency })
      }
    },
    updateLFOFilterCutoffRange () {
      if (this.lfo) {
        this.lfo.set({ min: this.lfoFilterCutoffRange[0], max: this.lfoFilterCutoffRange[1] })
      }
    },
    updateTremoloFrequency () {
      if (this.tremolo) {
        this.tremolo.set({ frequency: this.tremoloFrequency })
      }
    },
    updateTremoloDepth () {
      if (this.tremolo) {
        this.tremolo.set({ depth: this.tremoloDepth })
      }
    },
    updateSampleVolume (id, index) {
      if (this.players.has(id)) {
        this.players.player(id).volume.value = this.loadedSamples[index].volume
      }
      this.$forceUpdate()
    },
    updateAudioChain () {
      // If nothing is playing there is no graph to rewire; the next play()
      // builds a chain from the current checkbox state.
      if (!this.noise) {
        return
      }

      // Rebuild the effect sub-chain while playback is running. The Noise node
      // itself stays alive and is reconnected to the fresh output.
      this.disposeNode(this.lfo)
      this.lfo = null
      this.disposeNode(this.tremolo)
      this.tremolo = null
      this.disposeNode(this.filter)
      this.filter = null
      this.noise.disconnect()

      if (!this.isFilterEnabled && !this.isTremoloEnabled) {
        this.routeOutput(this.noise)
      } else if (!this.isFilterEnabled && this.isTremoloEnabled) {
        this.tremolo = new Tone.Tremolo({ frequency: this.tremoloFrequency, depth: this.tremoloDepth })
        this.routeOutput(this.tremolo)
        this.tremolo.start()
        this.noise.connect(this.tremolo)
      } else if (this.isFilterEnabled && !this.isTremoloEnabled) {
        this.filter = new Tone.Filter(this.filterCutoff, this.filterType)
        this.routeOutput(this.filter)
        this.noise.connect(this.filter)
      } else {
        this.tremolo = new Tone.Tremolo({ frequency: this.tremoloFrequency, depth: this.tremoloDepth })
        this.routeOutput(this.tremolo)
        this.tremolo.start()
        this.filter = new Tone.Filter(this.filterCutoff, this.filterType).connect(this.tremolo)
        this.noise.connect(this.filter)
      }

      if (this.isLFOFilterCutoffEnabled && this.filter) {
        this.lfo = new Tone.LFO({ frequency: this.lfoFilterCutoffFrequency, min: this.lfoFilterCutoffRange[0], max: this.lfoFilterCutoffRange[1] })
        this.lfo.connect(this.filter.frequency).start()
      }
    },
    populateProfileItems (profileId) {
      this.$http.get('/profiles')
        .then(response => {
          if (response.status === 200) {
            if (response.data.profiles.length === 0) {
              this.addDefaultProfile()
            } else {
              this.profileItems = response.data.profiles
              if (profileId === 0) {
                this.selectedProfile = this.profileItems[0]
              } else {
                this.selectedProfile = this.profileItems.find(p => p.id === profileId)
              }
              this.exportedProfile = this.profileItems[0]
              this.recordedProfile = this.profileItems[0]
              this.loadProfile(true)
            }
          }
        })
    },
    addDefaultProfile () {
      this.$http.post('/profiles/default')
        .then(response => {
          if (response.status === 200) {
            const defaultProfile = { id: response.data.id, text: 'Default' }
            this.profileItems = [defaultProfile]
            this.selectedProfile = defaultProfile
          }
        })
    },
    saveProfile () {
      this.$http.post('/profiles', {
        name: this.profileName,
        isTimerEnabled: this.isTimerEnabled,
        duration: this.duration,
        volume: this.volume,
        noiseColor: this.noiseColor,
        isFilterEnabled: this.isFilterEnabled,
        filterType: this.filterType,
        filterCutoff: this.filterCutoff,
        isLFOFilterCutoffEnabled: this.isLFOFilterCutoffEnabled,
        lfoFilterCutoffFrequency: this.lfoFilterCutoffFrequency,
        lfoFilterCutoffLow: this.lfoFilterCutoffRange[0],
        lfoFilterCutoffHigh: this.lfoFilterCutoffRange[1],
        isTremoloEnabled: this.isTremoloEnabled,
        tremoloFrequency: this.tremoloFrequency,
        tremoloDepth: this.tremoloDepth,
        samples: this.loadedSamples
      }).then(response => {
        if (response.status === 200) {
          this.profileDialog = false
          this.populateProfileItems(response.data.id)
          this.unsavedWork = false
          this.infoSnackbarText = 'Profile Saved'
          this.infoSnackbar = true
        }
      })
        .catch(() => {
          this.errorSnackbarText = 'Error Saving Profile'
          this.errorSnackbar = true
        })
    },
    updateProfile () {
      this.$http.put('/profiles/'.concat(this.selectedProfile.id), {
        isTimerEnabled: this.isTimerEnabled,
        duration: this.duration,
        volume: this.volume,
        noiseColor: this.noiseColor,
        isFilterEnabled: this.isFilterEnabled,
        filterType: this.filterType,
        filterCutoff: this.filterCutoff,
        isLFOFilterCutoffEnabled: this.isLFOFilterCutoffEnabled,
        lfoFilterCutoffFrequency: this.lfoFilterCutoffFrequency,
        lfoFilterCutoffLow: this.lfoFilterCutoffRange[0],
        lfoFilterCutoffHigh: this.lfoFilterCutoffRange[1],
        isTremoloEnabled: this.isTremoloEnabled,
        tremoloFrequency: this.tremoloFrequency,
        tremoloDepth: this.tremoloDepth,
        samples: this.loadedSamples
      }).then(response => {
        if (response.status === 200) {
          this.unsavedWork = false
          this.infoSnackbarText = 'Profile Saved'
          this.infoSnackbar = true
        }
      })
        .catch(() => {
          this.errorSnackbarText = 'Error Saving Profile'
          this.errorSnackbar = true
        })
    },
    loadProfile (checkForUnsavedWork) {
      if (checkForUnsavedWork && this.unsavedWork) {
        this.confirmSwitchProfileDialog = true
      } else {
        this.$http.get('/profiles/'.concat(this.selectedProfile.id))
          .then(response => {
            if (response.status === 200) {
              const profile = response.data.profile

              this.isTimerEnabled = profile.isTimerEnabled
              this.duration = profile.duration
              this.volume = profile.volume
              this.noiseColor = profile.noiseColor
              this.isFilterEnabled = profile.isFilterEnabled
              this.filterType = profile.filterType
              this.filterCutoff = profile.filterCutoff
              this.isLFOFilterCutoffEnabled = profile.isLFOFilterCutoffEnabled
              this.lfoFilterCutoffFrequency = profile.lfoFilterCutoffFrequency
              this.lfoFilterCutoffRange[0] = profile.lfoFilterCutoffLow
              this.lfoFilterCutoffRange[1] = profile.lfoFilterCutoffHigh
              this.isTremoloEnabled = profile.isTremoloEnabled
              this.tremoloFrequency = profile.tremoloFrequency
              this.tremoloDepth = profile.tremoloDepth

              this.loadedSamples = profile.samples

              this.activeProfile = profile

              if (this.unwatch) {
                this.unwatch()
              }

              this.unwatch = this.$watch('changeableSettings', function () {
                this.unsavedWork = true
              })
            }
          })
          .catch(() => {
            this.errorSnackbarText = 'Error Loading Profile'
            this.errorSnackbar = true
          })
      }
    },
    deleteProfile () {
      this.$http.delete('/profiles/'.concat(this.selectedProfile.id))
        .then(response => {
          if (response.status === 200) {
            this.populateProfileItems(0)
            this.infoSnackbarText = 'Profile Deleted'
            this.infoSnackbar = true
          }
        })
        .catch(() => {
          this.errorSnackbarText = 'Error Deleting Profile'
          this.errorSnackbar = true
        })
    },
    getSamples () {
      this.$http.get('/samples')
        .then(response => {
          if (response.status === 200) {
            this.allSamples = response.data.samples
            this.allSamples.forEach(s => {
              if (!this.players.has(s.id)) {
                this.players.add(s.id, '/samples/' + s.user + '_' + s.name).toDestination()
              }
            })
            this.mainPlayLoading = false
          }
        })
    },
    uploadSample () {
      const formData = new FormData()

      formData.append('name', this.sampleName)
      formData.append('sample', this.selectedSample)

      this.$http.post('/samples', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      })
        .then(response => {
          if (response.status === 200) {
            this.getSamples()
            this.populatePreviewSampleItems()
            this.infoSnackbarText = 'Sample Uploaded'
            this.infoSnackbar = true
          }
        })
        .catch((error) => {
          if (error.response.status === 409) {
            this.errorSnackbarText = 'Error Uploading Sample: Duplicate Sample Name'
          } else {
            this.errorSnackbarText = 'Error Uploading Sample'
          }
          this.errorSnackbar = true
        })

      this.uploadSampleDialog = false
    },
    addSample () {
      this.checkedSamples.forEach(i => {
        const load = this.allSamples.find(e => e.id === i)
        load.volume = -10
        load.sporadicMin = 30
        load.sporadicMax = 300
        this.loadedSamples.push(load)
      })

      this.addSampleDialog = false
      this.checkedSamples = []
    },
    removeSample (index) {
      this.loadedSamples.splice(index, 1)
    },
    getCurrentUser () {
      this.$http.get('/users/current')
        .then(response => {
          if (response.status === 200) {
            this.canUpload = response.data.user.canUpload
            this.$vuetify.theme.dark = response.data.user.darkMode
            const preferences = response.data.user.preferences
            this.$vuetify.theme.themes.dark.primary = preferences.accentColor.hex
            this.$vuetify.theme.themes.light.primary = preferences.accentColor.hex
          }
        })
    },
    resetProfileForm () {
      if (this.$refs.profileForm) {
        this.$refs.profileForm.reset()
      }
    },
    resetUploadSampleForm () {
      if (this.$refs.uploadSampleForm) {
        this.$refs.uploadSampleForm.reset()
      }
    },
    openImportDialog () {
      this.profileMoreDialog = false
      this.importDialog = true
    },
    openExportDialog () {
      this.profileMoreDialog = false
      this.exportDialog = true
    },
    async importProfile () {
      const fileContents = await this.readFile(this.importedProfile)
      const profileJSON = JSON.parse(fileContents)

      this.$http.post('/profiles/import', {
        name: this.importedProfileName,
        isTimerEnabled: profileJSON.isTimerEnabled,
        duration: profileJSON.duration,
        volume: profileJSON.volume,
        noiseColor: profileJSON.noiseColor,
        isFilterEnabled: profileJSON.isFilterEnabled,
        filterType: profileJSON.filterType,
        filterCutoff: profileJSON.filterCutoff,
        isLFOFilterCutoffEnabled: profileJSON.isLFOFilterCutoffEnabled,
        lfoFilterCutoffFrequency: profileJSON.lfoFilterCutoffFrequency,
        lfoFilterCutoffLow: profileJSON.lfoFilterCutoffLow,
        lfoFilterCutoffHigh: profileJSON.lfoFilterCutoffHigh,
        isTremoloEnabled: profileJSON.isTremoloEnabled,
        tremoloFrequency: profileJSON.tremoloFrequency,
        tremoloDepth: profileJSON.tremoloDepth
      }).then(response => {
        if (response.status === 200) {
          this.importDialog = false
          this.populateProfileItems(response.data.id)
          this.infoSnackbarText = 'Profile Imported and Saved'
          this.infoSnackbar = true
        }
      })
        .catch(() => {
          this.errorSnackbarText = 'Error Importing Profile'
          this.errorSnackbar = true
        })

      if (this.$refs.importForm) {
        this.$refs.importForm.reset()
      }
    },
    readFile (file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()

        reader.onload = res => {
          resolve(res.target.result)
        }
        reader.onerror = err => reject(err)

        reader.readAsText(file)
      })
    },
    exportProfile () {
      this.$http.get('/profiles/'.concat(this.exportedProfile.id))
        .then(response => {
          if (response.status === 200) {
            const profile = response.data.profile

            const profileJSON = {}
            profileJSON.name = this.exportedProfile.text
            profileJSON.isTimerEnabled = profile.isTimerEnabled
            profileJSON.duration = profile.duration
            profileJSON.volume = profile.volume
            profileJSON.noiseColor = profile.noiseColor
            profileJSON.isFilterEnabled = profile.isFilterEnabled
            profileJSON.filterType = profile.filterType
            profileJSON.filterCutoff = profile.filterCutoff
            profileJSON.isLFOFilterCutoffEnabled = profile.isLFOFilterCutoffEnabled
            profileJSON.lfoFilterCutoffFrequency = profile.lfoFilterCutoffFrequency
            profileJSON.lfoFilterCutoffLow = profile.lfoFilterCutoffLow
            profileJSON.lfoFilterCutoffHigh = profile.lfoFilterCutoffHigh
            profileJSON.isTremoloEnabled = profile.isTremoloEnabled
            profileJSON.tremoloFrequency = profile.tremoloFrequency
            profileJSON.tremoloDepth = profile.tremoloDepth

            const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(profileJSON))
            const downloadAnchorNode = document.createElement('a')
            downloadAnchorNode.setAttribute('href', dataStr)
            downloadAnchorNode.setAttribute('download', profileJSON.name + '.json')
            document.body.appendChild(downloadAnchorNode) // required for firefox
            downloadAnchorNode.click()
            downloadAnchorNode.remove()
          }
        })
        .catch(() => {
          this.errorSnackbarText = 'Error Exporting Profile'
          this.errorSnackbar = true
        })

      this.exportDialog = false
    },
    populatePreviewSampleItems () {
      this.$http.get('/samples')
        .then(response => {
          if (response.status === 200) {
            this.previewSampleItems = response.data.samples
            if (this.previewSampleItems.length > 0) {
              this.selectedPreviewSample = this.previewSampleItems[0]
            }
          }
        })
    },
    openEditSampleForm () {
      if (this.previewSampleItems.length > 0) {
        this.selectedPreviewSample = this.previewSampleItems[0]
      }
      this.loadPreviewSample()
    },
    closeEditSampleForm () {
      this.editSampleDialog = false
      this.previewSampleLoading = true
      if (this.previewSamplePlaying) {
        this.previewSamplePlaying = false
        this.previewSampleButtonText = 'Preview Sample'
        this.samplePreviewPlayer.stop()
      }
    },
    loadPreviewSample () {
      this.previewSampleLoading = true
      this.$http.get('/samples/'.concat(this.selectedPreviewSample.id))
        .then(async response => {
          if (response.status === 200) {
            const sample = response.data.sample

            await this.samplePreviewPlayer.load('/samples/' + sample.user + '_' + sample.name)

            this.previewSampleFadeIn = sample.fadeIn
            this.previewSampleLoopPointsEnabled = sample.loopPointsEnabled
            if (sample.loopPointsEnabled) {
              this.previewSampleLoopStart = sample.loopStart
              this.previewSampleLoopEnd = sample.loopEnd
              this.samplePreviewPlayer.setLoopPoints(this.previewSampleLoopStart, this.previewSampleLoopEnd)
            } else {
              this.previewSampleLoopStart = 0
              this.previewSampleLoopEnd = 0
            }
            this.samplePreviewPlayer.fadeIn = this.previewSampleFadeIn
            this.previewSampleLength = this.samplePreviewPlayer.buffer.duration
            this.previewSampleLoading = false
          }
        })
    },
    updatePreviewSampleLoopPoints () {
      if (this.previewSampleLoopPointsEnabled) {
        this.samplePreviewPlayer.setLoopPoints(this.previewSampleLoopStart, this.previewSampleLoopEnd)
      } else {
        this.samplePreviewPlayer.setLoopPoints(0, this.samplePreviewPlayer.buffer.duration)
      }
    },
    previewSample () {
      if (this.previewSamplePlaying) {
        this.previewSamplePlaying = false
        this.previewSampleButtonText = 'Preview Sample'
        this.samplePreviewPlayer.stop()
      } else {
        this.previewSamplePlaying = true
        this.previewSampleButtonText = 'Stop'
        this.samplePreviewPlayer.start()
      }
    },
    editSample () {
      this.$http.put('/samples/'.concat(this.selectedPreviewSample.id), {
        fadeIn: this.previewSampleFadeIn,
        loopPointsEnabled: this.previewSampleLoopPointsEnabled,
        loopStart: this.previewSampleLoopStart,
        loopEnd: this.previewSampleLoopEnd
      }).then(response => {
        if (response.status === 200) {
          this.getSamples()

          //  Update sample if it's already loaded in current profile
          const sample = this.loadedSamples.find(s => s.id === this.selectedPreviewSample.id)
          if (sample) {
            sample.fadeIn = this.previewSampleFadeIn
            sample.loopPointsEnabled = this.previewSampleLoopPointsEnabled
            sample.loopStart = this.previewSampleLoopStart
            sample.loopEnd = this.previewSampleLoopEnd
          }

          this.closeEditSampleForm()
          this.infoSnackbarText = 'Sample Saved'
          this.infoSnackbar = true
        }
      })
        .catch(() => {
          this.errorSnackbarText = 'Error Saving Sample'
          this.errorSnackbar = true
        })
    },
    updatePreviewSamplePlayerFadeIn () {
      this.samplePreviewPlayer.fadeIn = this.previewSampleFadeIn
    },
    updatePreviewSamplePlayerLoopPoints () {
      if (this.previewSampleLoopStart >= 0 && this.previewSampleLoopEnd <= this.previewSampleLength) {
        this.samplePreviewPlayer.setLoopPoints(this.previewSampleLoopStart, this.previewSampleLoopEnd)
      }
    },
    openStartRecordingDialog () {
      this.startRecordingDialog = true
      this.profileMoreDialog = false
    },
    snapshotCurrentSettings () {
      return {
        isTimerEnabled: this.isTimerEnabled,
        duration: this.duration,
        volume: this.volume,
        noiseColor: this.noiseColor,
        isFilterEnabled: this.isFilterEnabled,
        filterType: this.filterType,
        filterCutoff: this.filterCutoff,
        isLFOFilterCutoffEnabled: this.isLFOFilterCutoffEnabled,
        lfoFilterCutoffFrequency: this.lfoFilterCutoffFrequency,
        lfoFilterCutoffRange: this.lfoFilterCutoffRange.slice(),
        isTremoloEnabled: this.isTremoloEnabled,
        tremoloFrequency: this.tremoloFrequency,
        tremoloDepth: this.tremoloDepth,
        loadedSamples: this.loadedSamples.slice(),
        activeProfile: this.activeProfile,
        unwatch: this.unwatch
      }
    },
    restorePreRecordingSettings () {
      const snapshot = this.preRecordingSnapshot
      if (!snapshot) {
        return
      }

      // Re-arming the change-watcher after restoring would flag the restored
      // values as unsaved edits, so detach it across the restore and rebuild a
      // fresh watcher afterwards.
      if (this.unwatch) {
        this.unwatch()
      }

      this.isTimerEnabled = snapshot.isTimerEnabled
      this.duration = snapshot.duration
      this.volume = snapshot.volume
      this.noiseColor = snapshot.noiseColor
      this.isFilterEnabled = snapshot.isFilterEnabled
      this.filterType = snapshot.filterType
      this.filterCutoff = snapshot.filterCutoff
      this.isLFOFilterCutoffEnabled = snapshot.isLFOFilterCutoffEnabled
      this.lfoFilterCutoffFrequency = snapshot.lfoFilterCutoffFrequency
      this.lfoFilterCutoffRange = snapshot.lfoFilterCutoffRange.slice()
      this.isTremoloEnabled = snapshot.isTremoloEnabled
      this.tremoloFrequency = snapshot.tremoloFrequency
      this.tremoloDepth = snapshot.tremoloDepth
      this.loadedSamples = snapshot.loadedSamples
      this.activeProfile = snapshot.activeProfile

      this.unwatch = this.$watch('changeableSettings', function () {
        this.unsavedWork = true
      })
      this.unsavedWork = false
      this.preRecordingSnapshot = null
    },
    startRecording () {
      // Save current profile before recording
      this.updateProfile()

      this.$http.get('/profiles/'.concat(this.recordedProfile.id))
        .then(async response => {
          if (response.status === 200) {
            const profile = response.data.profile

            // Capture the live (pre-recording) configuration so it can be
            // restored synchronously when recording ends or is cancelled, even
            // if a later profile request would fail.
            this.preRecordingSnapshot = this.snapshotCurrentSettings()

            this.isTimerEnabled = profile.isTimerEnabled
            this.duration = profile.duration
            this.volume = profile.volume
            this.noiseColor = profile.noiseColor
            this.isFilterEnabled = profile.isFilterEnabled
            this.filterType = profile.filterType
            this.filterCutoff = profile.filterCutoff
            this.isLFOFilterCutoffEnabled = profile.isLFOFilterCutoffEnabled
            this.lfoFilterCutoffFrequency = profile.lfoFilterCutoffFrequency
            this.lfoFilterCutoffRange[0] = profile.lfoFilterCutoffLow
            this.lfoFilterCutoffRange[1] = profile.lfoFilterCutoffHigh
            this.isTremoloEnabled = profile.isTremoloEnabled
            this.tremoloFrequency = profile.tremoloFrequency
            this.tremoloDepth = profile.tremoloDepth

            this.loadedSamples = profile.samples

            this.startRecordingDialog = false
            this.recordingDialog = true
            this.recordingTimeElapsed = 0

            await this.playProfileForRecording()

            // Wait until Transport is actually running before starting recorder
            await new Promise(resolve => {
              const check = setInterval(() => {
                if (Tone.Transport.state === 'started') {
                  clearInterval(check)
                  resolve()
                }
              }, 10)
            })

            await this.recorder.start()
            this.isRecording = true
            this.recordingInterval = setInterval(() => this.recordingTimeElapsed++, 1000)
          }
        })
        .catch(() => {
          this.errorSnackbarText = 'Error Recording Profile'
          this.errorSnackbar = true
        })
    },
    async playProfileForRecording () {
      await Tone.start()

      // Release any graph left over from a previous run first so recording
      // chains never stack on top of normal-playback chains.
      this.releaseAudioChain()
      this.isRecording = true
      this.playDisabled = true

      this.buildNoiseChain()

      this.noise.sync().start(0)

      this.setupSamplePlayers(false, 0)

      Tone.Transport.start('+0.1')
    },
    async stopRecording () {
      let recording = null
      if (this.recorder.state === 'started') {
        recording = await this.recorder.stop()
      }
      this.isRecording = false
      clearInterval(this.recordingInterval)
      this.recordingInterval = null

      // Tear down the recording graph, sporadic timers and transport, and put
      // the pooled players back in their disconnected default state.
      this.releaseAudioChain()
      this.playDisabled = false
      this.timeRemaining = 0
      this.duration = 0

      // Restore the configuration that was active before recording started.
      this.restorePreRecordingSettings()

      if (recording) {
        const url = URL.createObjectURL(recording)
        const anchor = document.createElement('a')
        anchor.download = this.recordingFileName + '.webm'
        anchor.href = url
        anchor.click()
        URL.revokeObjectURL(url)
      }

      this.recordingDialog = false
    },
    async cancelRecording () {
      if (this.recorder.state === 'started') {
        await this.recorder.stop()
      }
      this.isRecording = false
      clearInterval(this.recordingInterval)
      this.recordingInterval = null

      this.releaseAudioChain()
      this.playDisabled = false
      this.timeRemaining = 0
      this.duration = 0

      // Cancelling must still return all settings to their pre-recording state.
      this.restorePreRecordingSettings()

      this.recordingDialog = false
    },
    discardChanges () {
      this.unsavedWork = false
      this.loadProfile(true)
      this.confirmSwitchProfileDialog = false
    },
    saveChanges () {
      // Set active profile back to previously selected one before saving
      this.selectedProfile = this.profileItems.find(p => p.text === this.activeProfile.name)
      this.updateProfile()
      this.confirmSwitchProfileDialog = false
    }
  }
}
