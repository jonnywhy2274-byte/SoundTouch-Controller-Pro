// ============================================================================
// BOSE SOUNDTOUCH CONTROLLER PRO - MASTER BUILD (V6.0 Gold Master)
// Architecture: 100% Local REST API & WebSocket (Cloud-Independent)
// This is a project undertaken by John Why. It's all about the music.
// ============================================================================

// ==========================================
// SECTION 1: GLOBAL VARIABLES & STATE
// ==========================================

// Legacy IP migration: If the old V3 app saved an IP, move it to the new V5 format
let legacyIp = localStorage.getItem("bose_ip");
if (legacyIp && !localStorage.getItem("activeSpeakerIp")) {
    localStorage.setItem("activeSpeakerIp", legacyIp);
    let tempRoster = [{ name: "My Speaker", ip: legacyIp, mac: "UNKNOWN_MAC", isMaster: false }];
    localStorage.setItem("speakerRoster", JSON.stringify(tempRoster));
}

// Core Network & Speaker State
let speakerRoster = JSON.parse(localStorage.getItem("speakerRoster")) || [];
let activeSpeakerIp = localStorage.getItem("activeSpeakerIp") || "";
let REST_URL = activeSpeakerIp ? `http://${activeSpeakerIp}:8090` : "";

// Unified XML Parser (Highly efficient, created once on boot)
const parser = new DOMParser();

// Active Session Tracking
let pendingSaveId = "";
let pendingSaveName = "";
let pendingSaveImg = "";
let pendingSaveType = "TUNEIN"; // Tracks if we are saving Radio or Spotify
let isGrouped = false;  
let currentMasterVol = 30; 
let isSceneMode = false;
let pendingSceneSlot = null;

// ==========================================
// SECTION 2: TRANSLATION ENGINE & TOAST UI
// ==========================================

const i18n = {
    en: {
        lbl_now_playing: "NOW PLAYING", lbl_volume: "VOLUME", lbl_radio: "RADIO",
        lbl_scenes: "SCENES", lbl_mixer: "MIXER 🎛️", btn_close: "Close",
        btn_search: "Search", title_connections: "Network & Speakers",
        desc_connections: "Manage your SoundTouch ecosystem.", btn_find_speakers: "🔍 Find Speakers",
        title_settings: "Device Settings", lbl_rename: "RENAME SPEAKER", lbl_bass: "BASS LEVEL",
        title_diagnostics: "System Diagnostics", msg_snapshot_saved: "Snapshot Saved!",
        msg_capture_failed: "Capture Failed", msg_bt_pairing: "Bluetooth Pairing Mode Active!",
        msg_bt_cleared: "Bluetooth Memory Cleared!", msg_connecting: "Connecting..."
    },
    de: {
        lbl_now_playing: "LÄUFT GERADE", lbl_volume: "LAUTSTÄRKE", lbl_radio: "RADIO",
        lbl_scenes: "SZENEN", lbl_mixer: "MIXER 🎛️", btn_close: "Schließen",
        btn_search: "Suchen", title_connections: "Netzwerk & Lautsprecher",
        desc_connections: "Verwalte dein SoundTouch-System.", btn_find_speakers: "🔍 Lautsprecher suchen",
        title_settings: "Geräteeinstellungen", lbl_rename: "LAUTSPRECHER UMBENENNEN", lbl_bass: "BASS-PEGEL",
        title_diagnostics: "Systemdiagnose", msg_snapshot_saved: "Szene gespeichert!",
        msg_capture_failed: "Fehler beim Speichern", msg_bt_pairing: "Bluetooth-Kopplung aktiv!",
        msg_bt_cleared: "Bluetooth-Speicher gelöscht!", msg_connecting: "Verbinde..."
    }
};

const browserLang = navigator.language.substring(0, 2);
const userLang = ['de'].includes(browserLang) ? browserLang : 'en';

function t(key) { return i18n[userLang][key] || i18n['en'][key] || key; }

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (el.tagName === 'INPUT' && el.placeholder !== undefined) el.placeholder = t(key);
        else el.innerText = t(key);
    });
}

let toastTimeout = null;
function showToast(message, duration = 3500) {
    const toast = document.getElementById("toast-container");
    if (!toast) return;
    toast.innerText = message;
    toast.classList.add("toast-visible");
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("toast-visible"), duration);
}

// ==========================================
// SECTION 3: BOOT SEQUENCE & WEBSOCKET
// ==========================================

window.onload = () => {
    applyTranslations(); 
    updatePresetLabels();
    
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.style.opacity = '0'; 
        setTimeout(() => {
            if (splash) splash.style.display = 'none'; 
            activeSpeakerIp ? startAppEngine() : document.getElementById('welcome-screen').style.display = "flex";
        }, 600); 
    }, 1500); 
};

function proceedToSetup() {
    document.getElementById('welcome-screen').style.display = "none";
    toggleModal('connectionsModal'); 
}

async function startAppEngine() {
    if (!activeSpeakerIp) return;
    updateHeaderName(); 
    await fetchAll(); 
    connectBoseSocket(); 

    setTimeout(syncHardwarePresets, 300);
    setTimeout(checkHardwareAndLoadSettings, 500); 
    setTimeout(fetchBassCapabilities, 600);
    setTimeout(fetchBalanceCapabilities, 700);
    setTimeout(fetchBass, 900);
    setTimeout(fetchBalance, 1000);
    setTimeout(fetchSpeakerName, 1200);
    
    // NEW: Fire the Tasker/URL Parameter sweep after the app is fully booted!
    setTimeout(handleUrlCommands, 1500);
}

async function playConnectionChime(speakerIp) {
    console.log(`🔊 Sending connection chime to ${speakerIp}...`);
    try {
        const response = await fetch(`http://${speakerIp}:8090/playNotification`);
        if (response.ok) console.log(`✅ Chime successful on ${speakerIp}`);
    } catch (e) {
        console.error(`❌ Failed to send chime to ${speakerIp}`, e);
    }
}

let boseSocket = null;
let pingInterval = null;
let hasChimed = false; // Add this line!

function connectBoseSocket() {
    if (boseSocket) { boseSocket.close(); clearInterval(pingInterval); }
    if (!activeSpeakerIp) return;

    boseSocket = new WebSocket(`ws://${activeSpeakerIp}:8080`, "gabbo");
    boseSocket.onopen = () => {
        
        // 🎵 ONLY CHIME IF IT'S THE VERY FIRST CONNECTION
        if (!hasChimed) {
            playConnectionChime(activeSpeakerIp);
            hasChimed = true; // Lock it so it never chimes again this session
        }
        
        pingInterval = setInterval(() => {
            if (boseSocket.readyState === WebSocket.OPEN) boseSocket.send(''); 
        }, 30000);
    };
    boseSocket.onmessage = (event) => handleSocketMessage(event.data);
    boseSocket.onclose = () => setTimeout(connectBoseSocket, 5000);
}

function handleSocketMessage(xmlString) {
    const xml = parser.parseFromString(xmlString, "text/xml");

    // 1. TRACK & ARTWORK UPDATE
    const nowPlayingNode = xml.querySelector("nowPlayingUpdated nowPlaying");
    if (nowPlayingNode) {
        const source = nowPlayingNode.getAttribute("source") || "STANDBY";
        let track = nowPlayingNode.querySelector("track")?.textContent || nowPlayingNode.querySelector("itemName")?.textContent || "Standby";
        let artist = nowPlayingNode.querySelector("artist")?.textContent || "";
        
        let artUrl = nowPlayingNode.querySelector("art")?.textContent || nowPlayingNode.querySelector("containerArt")?.textContent || "";
        const playStatus = nowPlayingNode.querySelector("playStatus")?.textContent || "";

        if (track === "not provided") track = (source === "BLUETOOTH") ? "Bluetooth Device" : "Connecting...";
        if (artist === "##TRANS_UNKNOWNARTIST##") artist = "Local Media"; 

        document.getElementById("ui-track").innerText = track;
        document.getElementById("ui-artist").innerText = artist;

        const artImg = document.getElementById("ui-art");
        const artPlaceholder = document.getElementById("art-placeholder");
        
        if (artUrl && artUrl.startsWith("http")) {
            artImg.src = artUrl; artImg.style.display = "block"; artPlaceholder.style.display = "none";
        } else {
            artImg.style.display = "none"; artPlaceholder.style.display = "block";
        }
        updateUIFeedback(source, false, playStatus); 
    }

    

    // 2. VOLUME SYNCHRONIZATION
    const volumeNode = xml.querySelector("volumeUpdated volume targetvolume") || xml.querySelector("volumeUpdated volume actualvolume");
    if (volumeNode) {
        const newVol = parseInt(volumeNode.textContent);
        const delta = newVol - currentMasterVol; 
        currentMasterVol = newVol; 
        
        const masterSlider = document.querySelector(`input[data-ip="${activeSpeakerIp}"]`);
        if (masterSlider) { masterSlider.value = newVol; masterSlider.nextElementSibling.innerText = newVol; }

        const volLabel = document.getElementById("vol-label");
        if (volLabel) volLabel.innerHTML = isGrouped ? t('lbl_mixer') : `${t('lbl_volume')}: ${currentMasterVol}`;

        const isSynced = document.getElementById("syncVolumesToggle")?.checked;
        if (isGrouped && isSynced && delta !== 0) {
            speakerRoster.forEach(speaker => {
                if (speaker.ip !== activeSpeakerIp) {
                    const slaveSlider = document.querySelector(`input[data-ip="${speaker.ip}"]`);
                    if (slaveSlider && !slaveSlider.disabled) {
                        let updatedVol = Math.max(0, Math.min(100, (parseInt(slaveSlider.value) || 30) + delta));
                        slaveSlider.value = updatedVol; slaveSlider.nextElementSibling.innerText = updatedVol;
                        fetch(`http://${speaker.ip}:8090/volume`, { method: 'POST', body: `<volume>${updatedVol}</volume>` }).catch(()=>{});
                    }
                }
            });
        }
    }

    // 3. MULTI-ROOM / ZONE UPDATE
    const zoneUpdateWrapper = xml.querySelector("zoneUpdated");
    if (zoneUpdateWrapper) {
        const zoneNode = zoneUpdateWrapper.querySelector("zone");
        const members = zoneNode ? zoneNode.querySelectorAll("member") : [];
        isGrouped = (members.length > 1);

        const btn = document.getElementById("groupBtn");
        if (btn) {
            btn.style.borderColor = isGrouped ? "var(--primary)" : "rgba(255,255,255,0.1)";
            btn.style.color = isGrouped ? "var(--primary)" : "var(--text-dim)";
            btn.style.boxShadow = isGrouped ? "0 0 12px rgba(0, 212, 255, 0.4)" : "none";
        }
        
        const volLabel = document.getElementById("vol-label");
        const sliderContainer = document.getElementById("party-sliders-container");
        let activeIps = Array.from(members).map(m => m.getAttribute("ipaddress"));
        const currentIpsString = activeIps.join(","); 

        if (isGrouped) {
            if (volLabel) {
                volLabel.innerHTML = "MIXER 🎛️"; volLabel.style.cursor = "pointer"; volLabel.style.color = "#000";
                volLabel.style.background = "var(--primary)"; volLabel.style.padding = "4px 12px"; volLabel.style.borderRadius = "12px";
            }
            if (sliderContainer && sliderContainer.dataset.ips !== currentIpsString) {
                sliderContainer.dataset.ips = currentIpsString; renderPartyDashboard(activeIps); 
            }
        } else {
            if (volLabel) {
                volLabel.innerHTML = `${t('lbl_volume')}: ${currentMasterVol}`; volLabel.style.cursor = "default";
                volLabel.style.background = "transparent"; volLabel.style.color = "var(--primary)"; volLabel.style.padding = "0";
            }
            if (sliderContainer && sliderContainer.dataset.ips !== currentIpsString) {
                sliderContainer.dataset.ips = currentIpsString;
                if (document.getElementById("mixerModal").style.display === "flex") renderPartyDashboard([]);
            }
        }
    }
}

// ==========================================
// SECTION 4: CORE API & TRANSPORT CONTROLS
// ==========================================

async function fetchAll() {
    if (!REST_URL) return;
    try {
        const [npRes, volRes, zoneRes] = await Promise.all([
            fetch(`${REST_URL}/now_playing`).catch(()=>null), fetch(`${REST_URL}/volume`).catch(()=>null), fetch(`${REST_URL}/getZone`).catch(()=>null)
        ]);
        if (npRes) handleSocketMessage((await npRes.text()).replace("<nowPlaying", "<nowPlayingUpdated><nowPlaying").replace("</nowPlaying>", "</nowPlaying></nowPlayingUpdated>"));
        if (volRes) handleSocketMessage((await volRes.text()).replace("<volume", "<volumeUpdated><volume").replace("</volume>", "</volume></volumeUpdated>"));
        if (zoneRes) {
            const text = await zoneRes.text();
            handleSocketMessage(text.includes("<member") ? text.replace("<zone", "<zoneUpdated><zone").replace("</zone>", "</zone></zoneUpdated>") : "<zoneUpdated></zoneUpdated>");
        }
    } catch (e) { console.error("FetchAll Error", e); }
}

async function changeVolume(delta) {
    if (!REST_URL) return;
    try {
        currentMasterVol = Math.max(0, Math.min(100, currentMasterVol + delta));
        const volLabel = document.getElementById("vol-label");
        if (!isGrouped && volLabel) volLabel.innerHTML = `${t('lbl_volume')}: ${currentMasterVol}`;
        
        await fetch(`${REST_URL}/volume`, { method: 'POST', body: `<volume>${currentMasterVol}</volume>` });

        if (isGrouped && document.getElementById("syncVolumesToggle")?.checked) {
            speakerRoster.forEach(speaker => {
                if (speaker.ip !== activeSpeakerIp) {
                    const slider = document.querySelector(`input[data-ip="${speaker.ip}"]`);
                    if (slider && !slider.disabled) {
                        let newSlaveVol = Math.max(0, Math.min(100, (parseInt(slider.value) || 30) + delta));
                        slider.value = newSlaveVol; slider.nextElementSibling.innerText = newSlaveVol;
                        fetch(`http://${speaker.ip}:8090/volume`, { method: 'POST', body: `<volume>${newSlaveVol}</volume>` }).catch(()=>{});
                    }
                }
            });
        }
    } catch (e) { console.debug("changeVolume failed:", e); }
}

async function sendKey(key) {
    if (!REST_URL) return;
    try {
        await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">${key}</key>` });
        await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">${key}</key>` });
    } catch (e) { console.debug("sendKey failed:", e); }
}

function togglePower() { sendKey('POWER'); }
function togglePlayPause() { sendKey('PLAY_PAUSE'); }
function skipPrev() { sendKey('PREV_TRACK'); }
function skipNext() { sendKey('NEXT_TRACK'); }

/**
 * Universal Spotify Ghost Link Engine with Automated Skip-Start
 */
async function castSpotifyGhostLink(spotifyUri) {
    try {
        const sourcesRes = await fetch(`${REST_URL}/sources`);
        const sourcesXml = parser.parseFromString(await sourcesRes.text(), "text/xml");
        const spotifyNodes = sourcesXml.querySelectorAll('sourceItem[source="SPOTIFY"]');
        let accountToUse = "SpotifyConnectUserName"; 
        
        spotifyNodes.forEach(node => {
            const acc = node.getAttribute("sourceAccount");
            if (acc && acc !== "SpotifyAlexaUserName") accountToUse = acc;
        });

        // Step 1: Wake speaker into Spotify
        await fetch(`${REST_URL}/select`, { method: 'POST', body: `<ContentItem source="SPOTIFY" sourceAccount="${accountToUse}"></ContentItem>` });

        // Step 2: Inject Ghost Link after a short delay
        setTimeout(async () => {
            document.getElementById("ui-track").innerText = "Forging Ghost Link...";
            document.getElementById("ui-artist").innerText = "Bypassing cloud...";

            const base64Uri = btoa(spotifyUri); 
            const xml = `
                <ContentItem source="SPOTIFY" type="DO_NOT_RESUME" location="/playback/container/${base64Uri}" sourceAccount="${accountToUse}" isPresetable="false">
                    <itemName>Spotify Cloud Cast</itemName>
                </ContentItem>
            `.trim();
            
            const response = await fetch(`${REST_URL}/select`, { method: 'POST', body: xml });
            
            if (response.ok) {
                showToast("Ghost Link Injected! Flushing buffer...");
                
                // Step 3: The Automated Skip-Start
                setTimeout(async () => {
                    try {
                        // Force a Skip to clear the frozen buffer
                        await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">NEXT_TRACK</key>` });
                        await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">NEXT_TRACK</key>` });
                        
                        // Wait 1 second for the new track to load, then force an EXPLICIT PLAY (not a toggle)
                        setTimeout(async () => {
                            await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">PLAY</key>` });
                            await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">PLAY</key>` });
                        }, 1000);
                        
                    } catch(e) {}
                }, 3500);

            } else {
                showToast("Routing via Spotify Connect...");
                window.location.href = spotifyUri;
            }
        }, 2000);
    } catch (e) { showToast("Connection Error."); }
}

/**
 * Unified Spotify Quick Resume
 * Wakes the speaker and kicks the audio buffer with an automated skip
 */
async function resumeSpotify() {
    if (!REST_URL) return;

    document.getElementById("ui-track").innerText = "Waking Spotify...";
    document.getElementById("ui-artist").innerText = "Resuming last session...";
    
    try {
        const sourcesRes = await fetch(`${REST_URL}/sources`);
        const sourcesXml = parser.parseFromString(await sourcesRes.text(), "text/xml");
        let accountToUse = "SpotifyConnectUserName"; 
        
        sourcesXml.querySelectorAll('sourceItem[source="SPOTIFY"]').forEach(node => {
            const acc = node.getAttribute("sourceAccount");
            if (acc && acc !== "SpotifyAlexaUserName") accountToUse = acc;
        });

        // 1. Wake the speaker
        await fetch(`${REST_URL}/select`, { 
            method: 'POST', 
            body: `<ContentItem source="SPOTIFY" sourceAccount="${accountToUse}"></ContentItem>` 
        });

        // 2. Wait 2.5 seconds for the daemon to boot, then apply the Skip-Kick!
        setTimeout(async () => {
            try {
                // Force the buffer to advance
                await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">NEXT_TRACK</key>` });
                await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">NEXT_TRACK</key>` });
                
                // Wait 1 second, then enforce PLAY
                setTimeout(async () => {
                    await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">PLAY</key>` });
                    await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">PLAY</key>` });
                    setTimeout(fetchAll, 1000);
                }, 1000);
            } catch(e) {}
        }, 2500);

    } catch (e) {
        showToast("Connection Error.");
    }
}

// ==========================================
// AMAZON MUSIC URL TRANSLATOR & CASTER
// ==========================================

async function castAmazonFromModal() {
    const userInput = document.getElementById("amazonDirectInput").value.trim();
    if (!userInput) { showToast("❌ Please enter a valid Amazon Link."); return; }

    // 1. The Regex Heat-Seeker
    // Looks for "albums/ID", "playlists/ID", etc. inside a standard URL
    const match = userInput.match(/(albums|playlists|stations|tracks)\/([a-zA-Z0-9]+)/i);
    
    if (!match) {
        showToast("❌ Unrecognized Amazon URL format.");
        return;
    }

    const type = match[1].toLowerCase();
    const id = match[2];
    let targetLocation = "";

    // 2. Translate to Bose XML grammar
    if (type === "albums") {
        targetLocation = `catalog/albums/${id}/#playable`;
    } else if (type === "playlists") {
        targetLocation = `catalog/playlists/${id}/#playable`;
    } else if (type === "stations") {
        targetLocation = `catalog/stations/${id}/#playable`; 
    } else if (type === "tracks") {
        targetLocation = `catalog/tracks/${id}/#playable`; 
    }

    toggleModal('amazonModal');
    document.getElementById("ui-track").innerText = "Translating URL...";
    document.getElementById("ui-artist").innerText = "Connecting to Amazon...";

    try {
        // 3. Scrape the hardware email
        const res = await fetch(`${REST_URL}/sources`);
        const xml = parser.parseFromString(await res.text(), "text/xml");
        const amazonNode = xml.querySelector('sourceItem[source="AMAZON"]');
        
        if (!amazonNode || amazonNode.getAttribute("status") !== "READY") {
            showToast("❌ No active Amazon account found.");
            return;
        }
        
        const amazonAccount = amazonNode.getAttribute("sourceAccount");

        // 4. Construct the Payload
        const payload = `
            <ContentItem source="AMAZON" type="tracklist" location="${targetLocation}" sourceAccount="${amazonAccount}">
                <itemName>Amazon Cloud Cast</itemName>
            </ContentItem>
        `.trim();

        // 5. Fire!
        const playRes = await fetch(`${REST_URL}/select`, { 
            method: 'POST', 
            body: payload 
        });

        if (playRes.ok) {
            showToast("🎵 Casting Amazon Audio!");
            setTimeout(fetchAll, 1500);
        } else {
            showToast("❌ Speaker rejected the payload.");
        }

    } catch(e) {
        showToast("Connection Error.");
    }
}

// Rename your previous Quick Resume logic so it runs from the modal
async function resumeAmazonQuick() {
    if (!REST_URL) return;

    document.getElementById("ui-track").innerText = "Waking Amazon...";
    document.getElementById("ui-artist").innerText = "Resuming last session...";
    
    try {
        const res = await fetch(`${REST_URL}/sources`);
        const xml = parser.parseFromString(await res.text(), "text/xml");
        const amazonNode = xml.querySelector('sourceItem[source="AMAZON"]');
        
        if (!amazonNode || amazonNode.getAttribute("status") !== "READY") return;
        const amazonAccount = amazonNode.getAttribute("sourceAccount");
        
        // Wake the speaker
        await fetch(`${REST_URL}/select`, { 
            method: 'POST', body: `<ContentItem source="AMAZON" sourceAccount="${amazonAccount}"></ContentItem>` 
        });

        // Apply the Skip-Kick
        setTimeout(async () => {
            try {
                await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">NEXT_TRACK</key>` });
                await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">NEXT_TRACK</key>` });
                setTimeout(async () => {
                    await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="press" sender="Gabbo">PLAY</key>` });
                    await fetch(`${REST_URL}/key`, { method: 'POST', body: `<key state="release" sender="Gabbo">PLAY</key>` });
                    setTimeout(fetchAll, 1000);
                }, 1000);
            } catch(e) {}
        }, 2500);
    } catch (e) {}
}

// ==========================================
// SPOTIFY MODAL CONTROLLERS
// ==========================================

function selectSpotify() {
    if (!REST_URL) return;
    document.getElementById("spotifyDirectInput").value = ""; 
    toggleModal('spotifyModal');
}

function castSpotifyFromModal() {
    const userInput = document.getElementById("spotifyDirectInput").value.trim();
    
    if (userInput === "") {
        showToast("❌ Please enter a valid Spotify Link.");
        return;
    }

    let spotifyUri = userInput;
    if (spotifyUri.startsWith("spotify:")) {
        if (spotifyUri.includes(":track:")) { showToast("❌ Single tracks cannot be cast!"); return; }
    } else {
        const match = spotifyUri.match(/(album|playlist|artist|track)\/([a-zA-Z0-9]+)/);
        if (match) {
            if (match[1] === "track") { showToast("❌ Single tracks cannot be cast!"); return; }
            spotifyUri = `spotify:${match[1]}:${match[2]}`;
        } else {
            showToast("❌ Unrecognized Spotify format."); return;
        }
    }

    const wantsToSave = confirm("Do you want to SAVE this Spotify link to a Preset button?\n\n[OK] = Save to Preset\n[Cancel] = Play Now");

    toggleModal('spotifyModal'); 

    if (wantsToSave) {
        const presetName = prompt("Enter a short name for this Spotify Preset:", "My Spotify Playlist");
        if (!presetName) return;
        pendingSaveId = spotifyUri; 
        pendingSaveName = `Spotify: ${presetName}`;
        pendingSaveImg = "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg"; 
        pendingSaveType = "SPOTIFY"; 
        document.getElementById("saveStationName").innerText = pendingSaveName;
        toggleModal('saveModal');
    } else {
        castSpotifyGhostLink(spotifyUri);
    }
}
// ==========================================
// HIDDEN STATIONS VAULT (TUNEIN BYPASS)
// ==========================================
async function playHiddenStation(stationId, stationName) {
    if (!REST_URL) return;
    
    // Close the modal and update UI
    toggleModal('bbcModal');
    document.getElementById("ui-track").innerText = "Tuning...";
    document.getElementById("ui-artist").innerText = stationName;
    showToast(`🎵 Tuning to ${stationName}...`);
    
    // Construct the EXACT direct-play XML payload the speaker demands
    const payload = `
        <ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/${stationId}" sourceAccount="">
            <itemName>${stationName}</itemName>
        </ContentItem>
    `.trim();
    
    try {
        const res = await fetch(`${REST_URL}/select`, {
            method: 'POST',
            body: payload
        });
        
        if (res.ok) {
            setTimeout(fetchAll, 1500); // Refresh the UI after it connects
        } else {
            showToast("❌ Speaker rejected the stream.");
        }
    } catch (e) {
        showToast("Connection Error.");
    }
}

async function selectAux() {
    if (!REST_URL) return;
    try {
        document.getElementById("ui-track").innerText = "Switching to AUX...";
        await fetch(`${REST_URL}/select`, { method: 'POST', body: '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>' });
    } catch (e) { console.debug("selectAux failed:", e); }
}

function updateUIFeedback(source, isMuted, playStatus) {
    // Make sure 'active-amazon' is added to this remove list!
    document.querySelectorAll('.cylindrical-btn').forEach(btn => btn.classList.remove('active-power', 'active-bt', 'active-aux', 'active-spotify', 'active-amazon', 'active-mute'));
    if (isMuted) document.getElementById('btn-mute')?.classList.add('active-mute');

    const playPauseBtn = document.getElementById('btn-playpause');
    if (playPauseBtn) {
        playPauseBtn.innerHTML = (playStatus === "PLAY_STATE" || playStatus === "BUFFERING_STATE") 
            ? `<svg class="svg-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
            : `<svg class="svg-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    }

    if (source === "STANDBY") return;
    document.getElementById('btn-power')?.classList.add('active-power');
    if (source === "BLUETOOTH") document.getElementById('btn-bt')?.classList.add('active-bt');
    else if (source === "AUX") document.getElementById('btn-aux')?.classList.add('active-aux');
    else if (source === "SPOTIFY") document.getElementById('btn-spotify')?.classList.add('active-spotify');
    // ADD THIS NEW LINE:
    else if (source === "AMAZON") document.getElementById('btn-amazon')?.classList.add('active-amazon');
}

// ==========================================
// SECTION 5: MULTI-ROOM ZONE MIXER
// ==========================================

function renderPartyDashboard(activeIps) {
    const container = document.getElementById("party-sliders-container");
    container.innerHTML = ""; 

    speakerRoster.forEach((speaker) => {
        const isMaster = speaker.ip === activeSpeakerIp;
        const isMember = activeIps.includes(speaker.ip) || isMaster;
        const checkboxHtml = isMaster
            ? `<input type="checkbox" class="mixer-checkbox" checked disabled>`
            : `<input type="checkbox" class="mixer-checkbox" ${isMember ? 'checked' : ''} onchange="toggleSpeakerInZone('${speaker.ip}', '${speaker.mac}', this.checked)">`;
        
        const row = document.createElement("div");
        row.id = `row-${speaker.ip}`;
        row.style.cssText = `display: flex; align-items: center; justify-content: space-between; opacity: ${isMember ? '1' : '0.5'}; transition: opacity 0.3s;`;
        row.innerHTML = `
            <div style="display:flex; align-items:center; gap: 10px; width: 110px; overflow: hidden;">
                ${checkboxHtml}
                <div style="text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; color: white; font-weight: bold;">${speaker.name}</div>
            </div>
            <input type="range" data-ip="${speaker.ip}" min="0" max="100" value="0" ${isMember ? '' : 'disabled'}
                   onchange="setIndividualVolume('${speaker.ip}', this.value)" oninput="this.nextElementSibling.innerText = this.value" style="flex: 1; margin: 0 10px;">
            <div class="vol-text" style="width: 30px; font-size: 0.9rem; color: var(--primary); text-align: right; font-weight: bold;">--</div>
        `;
        container.appendChild(row);

        if (isMember) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);

            fetch(`http://${speaker.ip}:8090/volume`, { signal: controller.signal })
                .then(res => { clearTimeout(timeoutId); return res.text(); })
                .then(text => {
                    const xml = parser.parseFromString(text, "text/xml");
                    const vol = xml.querySelector("targetvolume")?.textContent || xml.querySelector("volume")?.textContent || 30;
                    const slider = container.querySelector(`input[data-ip="${speaker.ip}"]`);
                    if (slider) { slider.value = vol; slider.nextElementSibling.innerText = vol; }
                }).catch(() => {
                    const volText = row.querySelector('.vol-text');
                    if (volText) { volText.innerHTML = "⚠️"; volText.style.color = "#E74C3C"; }
                    const slider = container.querySelector(`input[data-ip="${speaker.ip}"]`);
                    if (slider) slider.disabled = true;
                });
        }
    });
}

async function toggleSpeakerInZone(ip, mac, isAdding) {
    const masterSpeaker = speakerRoster.find(s => s.ip === activeSpeakerIp);
    if (!masterSpeaker) return;

    const row = document.getElementById(`row-${ip}`);
    const slider = document.querySelector(`input[data-ip="${ip}"]`);
    
    if (row) row.style.opacity = isAdding ? "1" : "0.5";
    if (slider) slider.disabled = !isAdding;

    try {
        if (isAdding) {
            if (!isGrouped) {
                const xml = `<zone master="${masterSpeaker.mac}"><member ipaddress="${activeSpeakerIp}">${masterSpeaker.mac}</member><member ipaddress="${ip}">${mac}</member></zone>`;
                await fetch(`http://${activeSpeakerIp}:8090/setZone`, { method: "POST", body: xml });
                isGrouped = true; 
            } else {
                await fetch(`http://${activeSpeakerIp}:8090/addZoneSlave`, { method: "POST", body: `<zone master="${masterSpeaker.mac}"><member ipaddress="${ip}">${mac}</member></zone>` });
            }
            if (slider) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const res = await fetch(`http://${ip}:8090/volume`);
                const volXml = parser.parseFromString(await res.text(), "text/xml");
                const vol = volXml.querySelector("targetvolume")?.textContent || volXml.querySelector("volume")?.textContent || 30;
                slider.value = vol; slider.nextElementSibling.innerText = vol;
            }
        } else {
            const checkedBoxes = document.querySelectorAll('.mixer-checkbox:checked');
            if (checkedBoxes.length <= 1) {
                await fetch(`http://${activeSpeakerIp}:8090/setZone`, { method: "POST", body: `<zone/>` });
                isGrouped = false; 
            } else {
                await fetch(`http://${activeSpeakerIp}:8090/removeZoneSlave`, { method: "POST", body: `<zone master="${masterSpeaker.mac}"><member ipaddress="${ip}">${mac}</member></zone>` });
            }
        }
    } catch (e) {
        if (row) {
            row.style.opacity = !isAdding ? "1" : "0.5";
            const volText = row.querySelector('.vol-text');
            if (volText) { volText.innerHTML = "⚠️"; volText.style.color = "#E74C3C"; }
        }
        if (slider) slider.disabled = true;
        const checkbox = document.querySelector(`#row-${ip} .mixer-checkbox`);
        if (checkbox) checkbox.checked = !isAdding;
    }
}

async function setIndividualVolume(ip, vol) {
    try { await fetch(`http://${ip}:8090/volume`, { method: 'POST', body: `<volume>${vol}</volume>` }); } catch(e) { console.debug("setIndividualVol failed:", e); }
}

// ==========================================
// SECTION 6: SEARCH & APP PRESETS
// ==========================================

async function searchStation() {
    const query = document.getElementById('searchInput').value.trim();
    const resultsDiv = document.getElementById('searchResults');
    if (!query) { resultsDiv.innerHTML = ""; return; }
    
    const headerHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 15px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); background: var(--panel); position: sticky; top: 0; z-index: 10; border-top-left-radius: 12px; border-top-right-radius: 12px;">
            <span style="color:var(--text-dim); font-weight:bold; font-size: 0.8rem; letter-spacing: 1px;">SEARCH RESULTS</span>
            <button type="button" onclick="document.getElementById('searchResults').innerHTML=''; document.getElementById('searchInput').value='';" style="background:var(--btn-bg); color:white; border:1px solid rgba(255,255,255,0.1); padding: 5px 12px; border-radius: 6px; font-size:0.8rem; font-weight:bold; cursor:pointer;">Close</button>
        </div>`;

    resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:var(--text-dim); text-align:center;'>Searching...</div>";
    
    try {
        const response = await fetch(`https://opml.radiotime.com/Search.ashx?query=${encodeURIComponent(query)}&render=json`);
        const data = await response.json();
        const stations = data.body.filter(item => item.type === 'audio');

        if (stations.length === 0) {
            resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:var(--text-dim); text-align:center;'>No stations found.</div>";
            return;
        }

        resultsDiv.innerHTML = headerHtml + stations.map(s => {
            const name = s.text || "Unknown Station";
            const id = s.guide_id || (s.URL ? new URLSearchParams(s.URL.split('?')[1]).get('id') : "");
            const safeImgUrl = (s.image || "").replace(/'/g, "%27"); 

            return `
            <div class="search-item" style="display:flex; align-items:center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 10px; padding-left: 12px; padding-right: 12px;">
                <div style="flex:1; padding-right:10px; line-height:1.3; overflow:hidden;">
                    <strong style="color:white; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</strong>
                    <small style="color:var(--primary);">TuneIn Station</small>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-icon btn-play" onclick="playStation('${id}', '${name.replace(/'/g, "")}')"><svg class="svg-icon-small" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                    <button class="btn-icon btn-add" onclick="openSaveModal('${id}', '${name.replace(/'/g, "")}', '${safeImgUrl}')"><svg class="svg-icon-small" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:#E74C3C; text-align:center;'>Search failed. Try again.</div>";
    }
}

// ==========================================
// SAVE CURRENTLY PLAYING STREAM
// ==========================================
async function saveCurrentlyPlaying() {
    if (!REST_URL) return;
    
    try {
        const res = await fetch(`${REST_URL}/now_playing`);
        const xml = parser.parseFromString(await res.text(), "text/xml");
        const source = xml.documentElement.getAttribute("source");
        const contentItem = xml.querySelector("ContentItem");

        if (!contentItem) {
            showToast("❌ Nothing currently playing to save.");
            return;
        }

        let location = contentItem.getAttribute("location");
        let artUrl = xml.querySelector("art")?.textContent || "";

        if (source === "SPOTIFY") {
            if (location && location.includes("/playback/container/")) {
                const base64 = location.split("/playback/container/")[1].split("?")[0];
                pendingSaveId = atob(base64); 
            } else {
                pendingSaveId = "spotify_quick_resume";
            }
            
            pendingSaveType = "SPOTIFY";
            
            let albumName = xml.querySelector("album")?.textContent;
            let stationName = xml.querySelector("stationName")?.textContent;
            let cleanName = stationName || albumName || "Spotify Session";
            
            pendingSaveName = `Spotify: ${cleanName}`; 
            pendingSaveImg = "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg"; 
            
            document.getElementById("saveStationName").innerText = pendingSaveName;
            toggleModal('saveModal');
            
        } else if (source === "TUNEIN") {
            let itemName = contentItem.querySelector("itemName")?.textContent || "Saved Stream";
            pendingSaveId = location.split("/v1/playback/station/")[1] || location;
            pendingSaveType = "TUNEIN";
            pendingSaveName = itemName;
            pendingSaveImg = artUrl;
            
            document.getElementById("saveStationName").innerText = pendingSaveName;
            toggleModal('saveModal');
        } else {
            showToast("❌ Only Spotify and TuneIn streams can be saved to Presets.");
        }
    } catch(e) {
        showToast("Connection Error.");
    }
}

async function fetchRecents() {
    if (!REST_URL) return;
    const resultsDiv = document.getElementById('searchResults');
    const headerHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 15px; border-bottom: 1px solid rgba(0, 212, 255, 0.2); background: var(--panel); position: sticky; top: 0; z-index: 10; border-top-left-radius: 12px; border-top-right-radius: 12px;">
            <span style="color:var(--primary); font-weight:bold; font-size: 0.8rem; letter-spacing: 1px;">RECENTLY PLAYED</span>
            <button type="button" onclick="document.getElementById('searchResults').innerHTML=''" style="background:var(--btn-bg); color:white; border:1px solid rgba(255,255,255,0.1); padding: 5px 12px; border-radius: 6px; font-size:0.8rem; font-weight:bold; cursor:pointer;">Close</button>
        </div>`;

    resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:var(--text-dim); text-align:center;'>Loading Recents...</div>";
    document.getElementById('settingsModal').style.display = "none";

    try {
        const response = await fetch(`${REST_URL}/recents`);
        const xml = parser.parseFromString(await response.text(), "text/xml");
        const stations = Array.from(xml.getElementsByTagName("recent")).filter(r => {
            let ci = r.getElementsByTagName("contentItem").length > 0 ? r.getElementsByTagName("contentItem") : r.getElementsByTagName("ContentItem");
            return ci.length > 0 && ci[0].getAttribute("source") === "TUNEIN";
        }).slice(0, 10); 

        if (stations.length === 0) {
            resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:var(--text-dim); text-align:center;'>No recent radio stations found.</div>";
            return;
        }

        resultsDiv.innerHTML = headerHtml + stations.map(s => {
            let ci = s.getElementsByTagName("contentItem").length > 0 ? s.getElementsByTagName("contentItem")[0] : s.getElementsByTagName("ContentItem")[0];
            let name = ci.getElementsByTagName("itemName")[0]?.textContent || "Unknown Station";
            const id = (ci.getAttribute("location") || "").split('/').pop(); 
            return `
            <div class="search-item" style="display:flex; align-items:center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 10px; padding-left: 12px; padding-right: 12px;">
                <div style="flex:1; padding-right:10px; line-height:1.3; overflow:hidden;">
                    <strong style="color:white; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</strong>
                    <small style="color:var(--primary);">Recently Played</small>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-icon btn-play" onclick="playStation('${id}', '${name.replace(/'/g, "")}')"><svg class="svg-icon-small" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        resultsDiv.innerHTML = headerHtml + "<div style='padding:20px; color:#E74C3C; text-align:center;'>Failed to load recents.</div>";
    }
}

async function playStation(id, name) {
    if (!REST_URL) return;
    try {
        document.getElementById("ui-track").innerText = "Tuning...";
        document.getElementById("ui-artist").innerText = name;
        document.getElementById('searchResults').innerHTML = "";
        document.getElementById('searchInput').value = "";
        await fetch(`${REST_URL}/select`, { method: 'POST', body: `<ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/${id}" sourceAccount=""><itemName>${name}</itemName></ContentItem>` });
    } catch (e) { console.debug("playStation failed:", e); }
}

// ==========================================
// SECTION 7: HARDWARE PRESET WRITE-BACK
// ==========================================

function openSaveModal(id, name, imgUrl = "") {
    pendingSaveId = id; pendingSaveName = name; pendingSaveImg = imgUrl; 
    pendingSaveType = "TUNEIN"; 
    document.getElementById("saveStationName").innerText = name;
    toggleModal('saveModal');
}

async function pushPresetToHardware(pNum, id, name) {
    if (!REST_URL) return;
    try {
        const contentItem = `
            <ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/${id}" sourceAccount="" isPresetable="true">
                <itemName>${name}</itemName>
                <containerArt/>
            </ContentItem>
        `;

        let res = await fetch(`${REST_URL}/preset`, { method: 'POST', body: `<preset id="${pNum}">${contentItem}</preset>` });

        if (!res.ok) {
            await new Promise(resolve => setTimeout(resolve, 200)); 
            res = await fetch(`${REST_URL}/presets`, { method: 'POST', body: `<presets><preset id="${pNum}">${contentItem}</preset></presets>` });
        }

        if (!res.ok) console.error(`Speaker rejected the payload. Status: ${res.status}`);
    } catch (e) {
        console.error("Hardware preset sync failed", e);
    }
}

async function executeSave(pNum) {
    localStorage.setItem(`custom_p${pNum}`, JSON.stringify({ 
        id: pendingSaveId, name: pendingSaveName, image: pendingSaveImg, type: pendingSaveType || "TUNEIN"
    }));
    
    toggleModal('saveModal');
    document.getElementById('searchResults').innerHTML = "";
    document.getElementById('searchInput').value = ""; 
    updatePresetLabels();
    
    if (pendingSaveType === "SPOTIFY") {
        showToast(`Spotify Link saved to App Preset ${pNum}!`);
    } else {
        await pushPresetToHardware(pNum, pendingSaveId, pendingSaveName);
        showToast(`Saved to Hardware Button ${pNum}!`);
        setTimeout(syncHardwarePresets, 1000);
    }
}

function updatePresetLabels() {
    for (let i = 1; i <= 6; i++) {
        const btn = document.getElementById(`p${i}`);
        if (!btn) continue;

        btn.style.justifyContent = "center";
        btn.style.padding = "5px";
        btn.style.backgroundImage = "none"; 
        btn.style.color = "var(--text-main)";

        if (isSceneMode) {
            const data = localStorage.getItem(`scene_p${i}`);
            if (data) {
                btn.innerHTML = `<span style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2;">${JSON.parse(data).name}</span>`;
                btn.className = "btn-preset custom scene-active";
                btn.style.opacity = "1";
            } else {
                btn.className = "btn-preset"; btn.innerHTML = `+ Scene ${i}`; btn.style.opacity = "0.5";
            }
        } else {
            const data = localStorage.getItem(`custom_p${i}`);
            if (data) {
                const preset = JSON.parse(data);
                btn.className = "btn-preset custom"; btn.style.opacity = "1"; btn.style.color = "var(--primary)";
                
                if (preset.image) {
                    btn.style.justifyContent = "flex-start"; btn.style.padding = "8px"; 
                    btn.innerHTML = `
                        <div style="width: 44px; height: 44px; border-radius: 8px; background-image: url('${preset.image}'); background-size: cover; background-position: center; flex-shrink: 0; box-shadow: 0 4px 8px rgba(0,0,0,0.4);"></div>
                        <div style="flex: 1; text-align: left; padding-left: 12px; font-size: 0.85rem; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${preset.name}</div>
                    `;
                } else {
                    btn.innerHTML = `<span style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2;">${preset.name}</span>`;
                }
            } else {
                btn.className = "btn-preset"; btn.innerHTML = i; btn.style.opacity = "1";
            }
        }
    }
}

function clearPreset(i) {
    if (isSceneMode) {
        if (localStorage.getItem(`scene_p${i}`) && confirm(`Delete Multiroom Scene ${i}?`)) {
            localStorage.removeItem(`scene_p${i}`); updatePresetLabels();
        }
    } else {
        if (localStorage.getItem(`custom_p${i}`) && confirm(`Remove custom station from Preset ${i}?`)) {
            localStorage.removeItem(`custom_p${i}`); updatePresetLabels(); syncHardwarePresets();
        }
    }
}

async function runPreset(i) {
    if (isSceneMode) {
        const data = localStorage.getItem(`scene_p${i}`);
        data ? executeScene(JSON.parse(data)) : openSceneModal(i);
        return; 
    }
    
    const data = localStorage.getItem(`custom_p${i}`);
    if (data) {
        const preset = JSON.parse(data);
        
        if (preset.type === "SPOTIFY") {
            if (preset.id === "spotify_quick_resume") {
                resumeSpotify();
            } else {
                document.getElementById("ui-track").innerText = "Waking Spotify...";
                document.getElementById("ui-artist").innerText = preset.name;
                await castSpotifyGhostLink(preset.id);
            }
        } else {
            document.getElementById("ui-track").innerText = "Tuning...";
            await fetch(`${REST_URL}/select`, { method: 'POST', body: `<ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/${preset.id}" sourceAccount=""><itemName>${preset.name}</itemName></ContentItem>` });
        }
    } else {
        document.getElementById("ui-track").innerText = `Loading Preset ${i}...`;
        await fetch(`${REST_URL}/select`, { method: 'POST', body: '<ContentItem source="TUNEIN"></ContentItem>' });
        await new Promise(resolve => setTimeout(resolve, 500));
        sendKey(`PRESET_${i}`);
    }
}
async function syncHardwarePresets() {
    if (!REST_URL) return;
    try {
        const xml = parser.parseFromString(await (await fetch(`${REST_URL}/presets`)).text(), "text/xml");
        const hardwarePresets = xml.getElementsByTagName("preset");

        for (let i = 0; i < hardwarePresets.length; i++) {
            const id = hardwarePresets[i].getAttribute("id");
            const name = hardwarePresets[i].getElementsByTagName("itemName")[0]?.textContent;
            
            if (!localStorage.getItem(`custom_p${id}`) && name && !isSceneMode) {
                const btn = document.getElementById(`p${id}`);
                if (btn) { 
                    btn.innerHTML = `<span style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2;">${name}</span>`; 
                    btn.style.opacity = "0.6"; btn.style.justifyContent = "center"; btn.style.padding = "5px";
                }
            }
        }
    } catch (e) { console.debug("syncHardwarePresets failed:", e); }
}

function togglePresetMode() {
    isSceneMode = document.getElementById("presetModeToggle").checked;
    document.getElementById("label-radio").style.color = isSceneMode ? "var(--text-dim)" : "var(--primary)";
    document.getElementById("label-scenes").style.color = isSceneMode ? "#b142ff" : "var(--text-dim)";
    updatePresetLabels(); 
    if (!isSceneMode) syncHardwarePresets();
}

// ==========================================
// SECTION 8: MULTI-ROOM SCENES (MACROS)
// ==========================================

function openSceneModal(i) {
    pendingSceneSlot = i;
    document.getElementById("sceneNameInput").value = "";
    toggleModal('sceneNameModal');
}

async function confirmSaveScene() {
    const name = document.getElementById("sceneNameInput").value.trim() || `Scene ${pendingSceneSlot}`;
    toggleModal('sceneNameModal');
    document.getElementById("ui-track").innerText = "Capturing Room State...";
    
    try {
        const sceneData = await captureCurrentState(name);
        localStorage.setItem(`scene_p${pendingSceneSlot}`, JSON.stringify(sceneData));
        updatePresetLabels();
        showToast(t('msg_snapshot_saved'));
        setTimeout(fetchAll, 2000); 
    } catch (e) { document.getElementById("ui-track").innerText = "Capture Failed"; }
}

async function captureCurrentState(sceneName) {
    const npXml = parser.parseFromString(await (await fetch(`${REST_URL}/now_playing`)).text(), "text/xml");
    const source = npXml.documentElement.getAttribute("source") || "STANDBY";
    const contentItemNode = npXml.querySelector("ContentItem");

    let zoneMembers = [];
    if (isGrouped) {
        const zoneXml = parser.parseFromString(await (await fetch(`${REST_URL}/getZone`)).text(), "text/xml");
        for (let m of zoneXml.querySelectorAll("member")) {
            const ip = m.getAttribute("ipaddress");
            let vol = 30; 
            try {
                const vXml = parser.parseFromString(await (await fetch(`http://${ip}:8090/volume`)).text(), "text/xml");
                vol = parseInt(vXml.querySelector("targetvolume")?.textContent || vXml.querySelector("volume")?.textContent || "30");
            } catch(e) {}
            zoneMembers.push({ ip, mac: m.textContent, volume: vol });
        }
    } else {
        zoneMembers.push({ ip: activeSpeakerIp, mac: speakerRoster.find(s => s.ip === activeSpeakerIp).mac, volume: currentMasterVol });
    }

    return {
        name: sceneName, source: source, sourceAccount: npXml.documentElement.getAttribute("sourceAccount") || "",
        contentItem: contentItemNode ? contentItemNode.outerHTML : null, 
        masterIp: activeSpeakerIp, members: zoneMembers
    };
}

async function executeScene(sceneData) {
    document.getElementById("ui-track").innerText = `Deploying ${sceneData.name}...`;
    document.getElementById("ui-artist").innerText = "Configuring speakers...";
    
    try {
        if (activeSpeakerIp !== sceneData.masterIp) {
             switchActiveSpeaker(sceneData.masterIp);
             await new Promise(r => setTimeout(r, 1000)); 
        }

        if (sceneData.source !== "STANDBY") {
            const sourceXml = sceneData.contentItem || `<ContentItem source="${sceneData.source}" sourceAccount="${sceneData.sourceAccount}"></ContentItem>`;
            await fetch(`${REST_URL}/select`, { method: "POST", body: sourceXml });
            await new Promise(r => setTimeout(r, 1000)); 
        }

        if (sceneData.members.length > 1) {
            const master = sceneData.members.find(m => m.ip === sceneData.masterIp);
            let membersXml = sceneData.members.map(m => `<member ipaddress="${m.ip}">${m.mac}</member>`).join('');
            await fetch(`${REST_URL}/setZone`, { method: "POST", body: `<zone master="${master.mac}">${membersXml}</zone>` });
            await new Promise(r => setTimeout(r, 1500)); 
        } else if (isGrouped) {
            await fetch(`${REST_URL}/setZone`, { method: "POST", body: `<zone/>` });
            await new Promise(r => setTimeout(r, 1000));
        }

        for (let m of sceneData.members) fetch(`http://${m.ip}:8090/volume`, { method: "POST", body: `<volume>${m.volume}</volume>` }).catch(()=>{});

        document.getElementById("ui-track").innerText = sceneData.name;
        document.getElementById("ui-artist").innerText = "Scene Active";
        setTimeout(fetchAll, 2000); 

    } catch(e) { document.getElementById("ui-track").innerText = "Scene Deployment Failed"; }
}

// ==========================================
// SECTION 9: HARDWARE SETTINGS & UTILITIES
// ==========================================

function toggleModal(modalId) {
    const modal = document.getElementById(modalId);
    const isOpening = (modal.style.display !== "flex"); 
    
    if (modalId === 'settingsModal' && isOpening) { fetchSpeakerName(); fetchAutoOff(); checkHardwareAndLoadSettings(); }
    if (modalId === 'connectionsModal' && isOpening) { document.getElementById("ipInput").value = activeSpeakerIp; updateSpeakerDropdown(); }
    if (modalId === 'mixerModal' && isOpening) renderPartyDashboard((document.getElementById("party-sliders-container").dataset.ips || "").split(',').filter(Boolean));

    modal.style.display = isOpening ? "flex" : "none";
}

function saveSettings() {
    const manualIp = document.getElementById("ipInput").value.trim();
    if (manualIp) {
        if (!speakerRoster.some(s => s.ip === manualIp)) speakerRoster.push({ name: "Unknown Speaker", ip: manualIp, mac: "UNKNOWN_MAC", type: "SoundTouch", isMaster: false });
        localStorage.setItem("speakerRoster", JSON.stringify(speakerRoster));
        switchActiveSpeaker(manualIp); updateSpeakerDropdown(); document.getElementById("ipInput").value = "";
    }
    toggleModal('connectionsModal');
}

function updateSpeakerDropdown() {
    const container = document.getElementById("speaker-selector-container");
    const list = document.getElementById("customSpeakerList");
    
    if (speakerRoster.length === 0) { container.style.display = "none"; return; }
    
    container.style.display = "block";
    list.innerHTML = speakerRoster.map(s => {
        const isActive = (s.ip === activeSpeakerIp);
        return `
        <button onclick="switchActiveSpeaker('${s.ip}')" oncontextmenu="deleteSpeaker('${s.ip}', '${s.name}'); return false;" style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: ${isActive ? "rgba(0, 212, 255, 0.15)" : "var(--btn-bg)"}; border: ${isActive ? "1px solid var(--primary)" : "1px solid transparent"}; color: ${isActive ? "var(--primary)" : "var(--text-main)"}; padding: 12px 15px; border-radius: 12px; cursor: pointer; transition: all 0.2s ease;">
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">${getHardwareIcon(s.type)}</div>
                <span style="font-weight: bold; font-size: 1rem;">${s.name}</span>
            </div>
            ${isActive ? `<span style="color: var(--primary); font-weight: bold;">✓</span>` : ``}
        </button>`;
    }).join('');
}

function switchActiveSpeaker(newIp) {
    activeSpeakerIp = newIp; localStorage.setItem("activeSpeakerIp", activeSpeakerIp);
    REST_URL = `http://${activeSpeakerIp}:8090`;
    updateHeaderName(); 
    
    document.getElementById("ui-track").innerText = "Switching Speakers...";
    document.getElementById("ui-artist").innerText = "Connecting...";
    document.getElementById('connectionsModal').style.display = "none";
    
    connectBoseSocket(); fetchAll(); syncHardwarePresets(); updatePresetLabels(); 
    fetchBassCapabilities(); fetchBass(); fetchBalanceCapabilities(); fetchBalance(); checkHardwareAndLoadSettings();
}

function deleteSpeaker(ip, name) {
    if (confirm(`Remove "${name}" from your saved speakers?`)) {
        speakerRoster = speakerRoster.filter(s => s.ip !== ip);
        localStorage.setItem("speakerRoster", JSON.stringify(speakerRoster));

        if (activeSpeakerIp === ip) {
            if (speakerRoster.length > 0) switchActiveSpeaker(speakerRoster[0].ip);
            else { activeSpeakerIp = ""; localStorage.removeItem("activeSpeakerIp"); REST_URL = ""; document.getElementById("ui-track").innerText = "No Speakers"; }
        }
        updateSpeakerDropdown();
    }
}

function getHardwareIcon(deviceType) {
    if (!deviceType) deviceType = "default";
    const type = deviceType.toLowerCase();
    if (type.includes("10")) return `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2" ry="2"></rect><circle cx="12" cy="14" r="3"></circle></svg>`;
    else if (type.includes("20") || type.includes("30") || type.includes("portable")) return `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"></rect><rect x="8" y="9" width="8" height="3" fill="currentColor"></rect></svg>`;
    else if (type.includes("300") || type.includes("soundbar")) return `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="10" width="20" height="4" rx="1" ry="1"></rect></svg>`;
    else return `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"></path></svg>`;
}

// Subnet Radar: Asynchronous IP sweeping engine
async function autoScan() {
    const scanBtn = document.querySelector("button[onclick='autoScan()']");
    if (scanBtn) scanBtn.innerText = "📡 Radar Sweeping (Est. 40s)...";

    speakerRoster = []; localStorage.removeItem("speakerRoster"); updateSpeakerDropdown();

    let baseIp = "192.168.0."; 
    if (activeSpeakerIp) { const parts = activeSpeakerIp.split('.'); parts.pop(); baseIp = parts.join('.') + '.'; }

    let ipsToScan = []; for(let i = 1; i < 255; i++) ipsToScan.push(baseIp + i);
    let foundCount = 0;

    async function checkIp(ip) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500); 
        try {
            const res = await fetch(`http://${ip}:8090/info`, { signal: controller.signal });
            clearTimeout(timeoutId); 
            if (res.ok) {
                const text = await res.text();
                const nameMatch = text.match(/<name>(.*?)<\/name>/);
                if (nameMatch && !speakerRoster.some(s => s.ip === ip)) {
                    const macMatch = text.match(/<macAddress>(.*?)<\/macAddress>/);
                    const typeMatch = text.match(/<type>(.*?)<\/type>/); 
                    speakerRoster.push({ name: nameMatch[1], ip: ip, mac: (macMatch && macMatch[1]) ? macMatch[1] : "UNKNOWN_MAC", type: (typeMatch && typeMatch[1]) ? typeMatch[1] : "SoundTouch", isMaster: false });
                    foundCount++;
                    if (scanBtn) scanBtn.innerText = `📡 Sweeping... (Found ${foundCount})`;
                    localStorage.setItem("speakerRoster", JSON.stringify(speakerRoster)); updateSpeakerDropdown();
                    if (!activeSpeakerIp) switchActiveSpeaker(ip);
                }
            }
        } catch (e) { clearTimeout(timeoutId); }
    }

    let currentIndex = 0;
    const workers = Array(10).fill(0).map((_, i) => (async () => {
        await new Promise(r => setTimeout(r, i * 150));
        while (currentIndex < ipsToScan.length) { await checkIp(ipsToScan[currentIndex++]); await new Promise(r => setTimeout(r, 50)); }
    })());
    await Promise.all(workers);

    if (scanBtn) { scanBtn.innerText = "🔍 Auto-Scan Network"; scanBtn.style.background = "var(--btn-bg)"; scanBtn.style.color = "var(--primary)"; }
    if (speakerRoster.length === 0) alert("Scan complete. No speakers found. Please enter an IP manually.");
}

async function checkHardwareAndLoadSettings() {
    if (!REST_URL) return;
    try {
        const [resInfo, resSources, resCap] = await Promise.all([ fetch(`${REST_URL}/info`), fetch(`${REST_URL}/sources`), fetch(`${REST_URL}/capabilities`) ]);
        const deviceType = (await resInfo.text()).match(/<type>(.*?)<\/type>/)?.[1];
        const hasBluetooth = (await resSources.text()).includes('source="BLUETOOTH"');
        const isStereoCapable = (await resCap.text()).includes("<lrStereoCapable>true</lrStereoCapable>");

        if (deviceType) {
            let rosterUpdated = false;
            speakerRoster.forEach(speaker => {
                if (speaker.ip === activeSpeakerIp && (speaker.type !== deviceType || speaker.isStereoCapable !== isStereoCapable)) {
                    speaker.type = deviceType; speaker.isStereoCapable = isStereoCapable; rosterUpdated = true;
                }
            });
            if (rosterUpdated) localStorage.setItem("speakerRoster", JSON.stringify(speakerRoster));

            const connectionBtn = document.querySelector(".btn-connections");
            if (connectionBtn) connectionBtn.innerHTML = getHardwareIcon(deviceType);

            const clockSection = document.getElementById("clockControlSection");
            if (deviceType.includes("20") || deviceType.includes("30") || deviceType.includes("Portable")) {
                clockSection.style.display = "flex"; fetchClockState(); 
            } else clockSection.style.display = "none"; 
        }

        document.getElementById("btn-bt").style.display = hasBluetooth ? "flex" : "none";
        document.getElementById("bt-tips-section").style.display = hasBluetooth ? "block" : "none";

        const capableCount = speakerRoster.filter(s => s.isStereoCapable === true || (s.type && s.type.includes("10"))).length;
        const stereoBtnContainer = document.getElementById("stereoPairingSection");
        if (stereoBtnContainer) stereoBtnContainer.style.display = (capableCount >= 2) ? "block" : "none";

    } catch (e) { console.debug("Hardware Check Failed:", e); }
}

async function fetchSpeakerName() {
    if (!REST_URL) return;
    try {
        const match = (await (await fetch(`${REST_URL}/name`)).text()).match(/<name>(.*?)<\/name>/);
        const inputField = document.getElementById("speakerNameInput");
        if (match && match[1]) { inputField.placeholder = match[1]; inputField.value = match[1]; }
    } catch (e) { console.debug("fetchSpeakerName failed:", e); }
}

async function renameSpeaker() {
    if (!REST_URL) return;
    const inputField = document.getElementById("speakerNameInput");
    const newName = inputField.value.trim();
    if (!newName) return; 

    try {
        if ((await fetch(`${REST_URL}/name`, { method: "POST", body: `<name>${newName}</name>` })).ok) {
            inputField.placeholder = newName; inputField.value = "";
            speakerRoster.forEach(s => { if (s.ip === activeSpeakerIp) s.name = newName; });
            localStorage.setItem("speakerRoster", JSON.stringify(speakerRoster));
            updateSpeakerDropdown(); updateHeaderName();
            const btn = inputField.nextElementSibling;
            const originalText = btn.innerText; btn.innerText = "✓"; btn.style.background = "#4CAF50"; 
            setTimeout(() => { btn.innerText = originalText; btn.style.background = "var(--primary)"; }, 2000);
        }
    } catch (e) { console.debug("renameSpeaker failed:", e); }
}

function updateHeaderName() {
    const headerElement = document.getElementById('active-speaker-title');
    if (headerElement) headerElement.innerText = speakerRoster.find(s => s.ip === activeSpeakerIp)?.name.toUpperCase() || t('lbl_now_playing');
}

async function fetchBassCapabilities() {
    if (!REST_URL) return;
    try {
        const xml = parser.parseFromString(await (await fetch(`${REST_URL}/bassCapabilities`)).text(), "text/xml");
        if (xml.querySelector("bassAvailable")?.textContent === "true") {
            const min = xml.querySelector("bassMin")?.textContent || "-9", max = xml.querySelector("bassMax")?.textContent || "0";
            const slider = document.getElementById("bassSlider");
            slider.setAttribute("min", min); slider.setAttribute("max", max);
            document.getElementById("bassMinLabel").innerText = min; document.getElementById("bassMaxLabel").innerText = (parseInt(max) > 0 ? "+" : "") + max; 
        } else document.getElementById("bassControlSection").style.display = "none";
    } catch (e) { console.debug("fetchBassCap failed:", e); }
}

async function fetchBass() {
    if (!REST_URL) return;
    try {
        const xml = parser.parseFromString(await (await fetch(`${REST_URL}/bass`)).text(), "text/xml");
        const currentBass = xml.querySelector("targetbass")?.textContent || xml.querySelector("bass")?.textContent;
        if (currentBass !== undefined) document.getElementById("bassSlider").value = currentBass;
    } catch (e) { console.debug("fetchBass failed:", e); }
}

async function setBass(value) { try { await fetch(`${REST_URL}/bass`, { method: "POST", body: `<bass>${value}</bass>` }); } catch (e) { console.debug("setBass failed:", e); } }

async function fetchBalanceCapabilities() {
    if (!REST_URL) return;
    try {
        const xml = parser.parseFromString(await (await fetch(`${REST_URL}/balance`)).text(), "text/xml");
        if (xml.querySelector("balanceAvailable")?.textContent === "true") {
            document.getElementById("balanceSlider").setAttribute("min", xml.querySelector("balanceMin")?.textContent || "-7");
            document.getElementById("balanceSlider").setAttribute("max", xml.querySelector("balanceMax")?.textContent || "7");
            document.getElementById("balanceControlSection").style.display = "block";
        } else document.getElementById("balanceControlSection").style.display = "none";
    } catch (e) { document.getElementById("balanceControlSection").style.display = "none"; }
}

async function fetchBalance() {
    if (!REST_URL) return;
    try {
        const xml = parser.parseFromString(await (await fetch(`${REST_URL}/balance`)).text(), "text/xml");
        const currentBalance = xml.querySelector("targetBalance")?.textContent || xml.querySelector("actualBalance")?.textContent;
        if (currentBalance !== undefined) document.getElementById("balanceSlider").value = currentBalance;
    } catch (e) { console.debug("fetchBalance failed:", e); }
}

async function setBalance(value) { try { await fetch(`${REST_URL}/balance`, { method: "POST", body: `<balance>${value}</balance>` }); } catch (e) { console.debug("setBalance failed:", e); } }

async function fetchClockState() {
    if (!REST_URL) return;
    try {
        const text = await (await fetch(`${REST_URL}/clockDisplay`)).text();
        document.getElementById("clockToggle").checked = text.includes('userEnable="true"'); 
    } catch (e) { console.debug("fetchClockState failed:", e); }
}

async function updateClockSettings() {
    if (!REST_URL) return;
    try { await fetch(`${REST_URL}/clockDisplay`, { method: "POST", body: `<clockDisplay><clockConfig userEnable="${document.getElementById("clockToggle").checked}"/></clockDisplay>` }); } catch (e) { console.debug("updateClockSettings failed:", e); }
}

async function fetchAutoOff() {
    if (!REST_URL) return;
    try {
        const match = (await (await fetch(`${REST_URL}/systemtimeout`)).text()).match(/<powersaving_enabled>(.*?)<\/powersaving_enabled>/);
        if (match && match[1]) document.getElementById("autoOffToggle").checked = (match[1] === "true");
    } catch (e) { console.debug("fetchAutoOff failed:", e); }
}

async function setAutoOff(isEnabled) {
    if (!REST_URL) return;
    try { await fetch(`${REST_URL}/systemtimeout`, { method: "POST", body: `<systemtimeout><powersaving_enabled>${isEnabled}</powersaving_enabled></systemtimeout>` }); } catch (e) { console.debug("setAutoOff failed:", e); }
}

let btClickTimer = null;
function handleSmartBluetooth() {
    if (btClickTimer === null) {
        btClickTimer = setTimeout(() => { selectBluetooth(); btClickTimer = null; }, 300); 
    } else {
        clearTimeout(btClickTimer); btClickTimer = null; enterBluetoothPairing(); 
    }
}

async function selectBluetooth() {
    if (!REST_URL) return;
    try {
        document.getElementById("ui-track").innerText = "Switching to Bluetooth...";
        await fetch(`${REST_URL}/select`, { method: 'POST', body: '<ContentItem source="BLUETOOTH" sourceAccount=""></ContentItem>' });
        setTimeout(fetchAll, 1500);
    } catch (e) { console.debug("selectBluetooth failed:", e); }
}

async function enterBluetoothPairing() {
    if (!REST_URL) return;
    try {
        fetch(`${REST_URL}/select`, { method: 'POST', body: '<ContentItem source="BLUETOOTH" sourceAccount=""></ContentItem>' });
        setTimeout(() => fetch(`${REST_URL}/enterBluetoothPairing`, { method: "POST" }), 200);
        setTimeout(() => fetch(`${REST_URL}/enterPairingMode`, { method: "POST" }), 400);
        setTimeout(() => fetch(`${REST_URL}/setPairingStatus`, { method: "POST", body: '<pairingStatus>true</pairingStatus>' }), 600);
        showToast(t('msg_bt_pairing'));
        setTimeout(fetchAll, 2000); 
    } catch (e) { console.debug("enterBluetoothPairing failed:", e); }
}

async function clearBluetoothList() {
    if (!REST_URL || !confirm("Clear all Bluetooth devices? (You must also 'Forget' the speaker in your phone's settings)")) return;
    try {
        await fetch(`${REST_URL}/select`, { method: 'POST', body: '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>' });
        await new Promise(resolve => setTimeout(resolve, 2000));
        fetch(`${REST_URL}/clearBluetoothPaired`, { method: "POST" });
        setTimeout(() => fetch(`${REST_URL}/clearPairedList`, { method: "POST" }), 200);
        showToast(t('msg_bt_cleared'));
        setTimeout(fetchAll, 2000); 
    } catch (e) { console.debug("clearBluetoothList failed:", e); }
}

function openStereoPairingUi() {
    const leftSelect = document.getElementById("leftSpeakerSelect"), rightSelect = document.getElementById("rightSpeakerSelect");
    leftSelect.innerHTML = ""; rightSelect.innerHTML = "";
    
    const capableSpeakers = speakerRoster.filter(s => s.isStereoCapable === true);

    if (capableSpeakers.length === 0) {
        leftSelect.innerHTML = `<option disabled>No compatible speakers found.</option>`; rightSelect.innerHTML = `<option disabled>No compatible speakers found.</option>`;
        showToast("Tap 'Find Speakers' in Network to update capabilities.");
    } else {
        capableSpeakers.forEach(s => { const opt = `<option value="${s.ip}" data-mac="${s.mac}">${s.name}</option>`; leftSelect.innerHTML += opt; rightSelect.innerHTML += opt; });
        if (activeSpeakerIp && capableSpeakers.some(s => s.ip === activeSpeakerIp)) leftSelect.value = activeSpeakerIp;
        const remaining = capableSpeakers.filter(s => s.ip !== leftSelect.value);
        if (remaining.length > 0) rightSelect.value = remaining[0].ip;
        else if (capableSpeakers.length === 1) showToast("Only 1 capable speaker found. Connect to your other ST10 first!");
    }
    toggleModal('settingsModal'); toggleModal('stereoPairModal'); 
}

async function createStereoPair() {
    const leftSelect = document.getElementById("leftSpeakerSelect");
    const rightSelect = document.getElementById("rightSpeakerSelect");
    
    const leftIp = leftSelect.value;
    const rightIp = rightSelect.value;
    
    if (leftIp === rightIp) { showToast("Please select two different speakers!"); return; }

    const leftSpeaker = speakerRoster.find(s => s.ip === leftIp);
    const rightSpeaker = speakerRoster.find(s => s.ip === rightIp);

    try {
        document.getElementById("ui-track").innerText = "Pairing Speakers..."; 
        toggleModal('stereoPairModal');
        
        const groupName = `${leftSpeaker.name} + ${rightSpeaker.name}`;
        const xml = `
        <group>
            <name>${groupName}</name>
            <masterDeviceId>${leftSpeaker.mac}</masterDeviceId>
            <roles>
                <groupRole>
                    <deviceId>${leftSpeaker.mac}</deviceId>
                    <role>LEFT</role>
                    <ipAddress>${leftIp}</ipAddress>
                </groupRole>
                <groupRole>
                    <deviceId>${rightSpeaker.mac}</deviceId>
                    <role>RIGHT</role>
                    <ipAddress>${rightIp}</ipAddress>
                </groupRole>
            </roles>
        </group>`.trim();

        const response = await fetch(`http://${leftIp}:8090/addGroup`, { method: 'POST', body: xml });
        
        if (response.ok) {
            showToast("Stereo Pair Created Successfully!");
            if (activeSpeakerIp !== leftIp) switchActiveSpeaker(leftIp);
            setTimeout(fetchAll, 3000); 
        } else {
            showToast("Pairing failed. Ensure both speakers are ST-10s.");
        }
    } catch (e) { showToast("Network error during pairing."); }
}

async function separateStereoPair() {
    if (!REST_URL || !confirm("Are you sure you want to separate the current stereo pair?")) return;
    try {
        await fetch(`${REST_URL}/removeGroup`, { method: 'POST' });
        toggleModal('stereoPairModal'); 
        showToast("Speakers Separated!"); 
        setTimeout(fetchAll, 3000);
    } catch (e) { showToast("Failed to separate speakers."); }
}

async function openDiagnostics() {
    toggleModal('settingsModal'); toggleModal('diagnosticModal'); 
    document.getElementById("diag-terminal").innerHTML = "Establishing secure connection...<br>Fetching hardware telemetry...";
    if (!REST_URL) { document.getElementById("diag-terminal").innerHTML = "Error: No active speaker connected."; return; }

    try {
        const [netInfoRes, netStatsRes] = await Promise.all([ fetch(`${REST_URL}/networkInfo`), fetch(`${REST_URL}/netStats`) ]);
        const netInfoXml = parser.parseFromString(await netInfoRes.text(), "text/xml");
        const netStatsXml = parser.parseFromString(await netStatsRes.text(), "text/xml");

        const rssi = (netStatsXml.querySelector("rssi")?.textContent || "N/A").toLowerCase();
        let statusColor = "#E74C3C"; 
        if (rssi === 'excellent') statusColor = "#00FF41"; else if (rssi === 'good') statusColor = "#FFC107"; else if (rssi === 'average') statusColor = "#FF8C00"; 

        document.getElementById("diag-terminal").innerHTML = `
            <span style="color:var(--text-dim);">IP_ADDRESS:</span> ${netStatsXml.querySelector("ipv4address")?.textContent || activeSpeakerIp}<br>
            <span style="color:var(--text-dim);">MAC_ADDRESS:</span> ${netStatsXml.querySelector("mac-addr")?.textContent || netInfoXml.querySelector("interface")?.getAttribute("macAddress") || "UNKNOWN"}<br>
            <span style="color:var(--text-dim);">SERIAL_NUM:</span> ${netStatsXml.querySelector("deviceSerialNumber")?.textContent || "UNKNOWN"}<br>
            <br>
            <span style="color:var(--text-dim);">ACTIVE_NETWORK:</span> ${netStatsXml.querySelector("ssid")?.textContent || "Wired / Unknown"}<br>
            <span style="color:var(--text-dim);">SIGNAL_HEALTH:</span> <span style="color:${statusColor}; font-weight:bold;">${rssi.toUpperCase()}</span><br>
            <span style="color:var(--text-dim);">STORED_PROFILES:</span> ${netInfoXml.querySelector("networkInfo")?.getAttribute("wifiProfileCount") || "0"}
        `;
    } catch (e) { document.getElementById("diag-terminal").innerHTML = "Connection timeout. Hardware unresponsive."; }
}

// ==========================================
// SECTION 10: LOCAL MUSIC BROWSER (UNIVERSAL)
// ==========================================

let LOCAL_PC_URL = localStorage.getItem("bose_local_pc_url") || "";
let LOCAL_ACCOUNT_UUID = localStorage.getItem("bose_local_uuid") || "";

async function syncLocalLibrary() {
    if (!REST_URL) return;
    const container = document.getElementById("dlnaList");
    container.innerHTML = `<div style='padding:20px; color:var(--text-dim); text-align:center;'>Interrogating Speaker...</div>`;

    try {
        const response = await fetch(`${REST_URL}/now_playing`);
        const xmlString = await response.text();
        const xml = parser.parseFromString(xmlString, "text/xml");
        const npNode = xml.querySelector("nowPlaying");
        
        if (!npNode || npNode.getAttribute("source") !== "LOCAL_MUSIC") {
            container.innerHTML = `
                <div style='padding:20px; color:#E74C3C; text-align:center;'>
                    <strong>No Local Music Detected!</strong><br><br>
                    Please ensure a track from your Computer Library is actively playing out of the speaker right now, then try again.
                </div>
                <button onclick="openLocalVault()" style="background:var(--btn-bg); color:white; width:100%; padding:10px; border-radius:8px; border:none; margin-top:10px;">⬅ Try Again</button>
            `;
            return;
        }
        
        const uuid = npNode.getAttribute("sourceAccount");
        const artNode = xml.querySelector("containerArt") || xml.querySelector("art");
        let pcUrl = "";
        
        if (artNode && artNode.textContent && artNode.textContent.startsWith("http")) {
            const urlObj = new URL(artNode.textContent);
            pcUrl = `${urlObj.protocol}//${urlObj.host}`; 
        }
        
        if (uuid && pcUrl) {
            localStorage.setItem("bose_local_uuid", uuid);
            localStorage.setItem("bose_local_pc_url", pcUrl);
            LOCAL_ACCOUNT_UUID = uuid; LOCAL_PC_URL = pcUrl;
            showToast("Library Synced Successfully!");
            openLocalVault('albums'); 
        } else {
            container.innerHTML = `<div style='padding:20px; color:#E74C3C; text-align:center;'>Failed to extract library path. Ensure the track has album art.</div>`;
        }
    } catch (e) {
        container.innerHTML = `<div style='padding:20px; color:#E74C3C; text-align:center;'>Connection Error during Sync.</div>`;
    }
}

async function openLocalVault(tab = 'albums') {
    const container = document.getElementById("dlnaList");
    document.getElementById("dlnaBreadcrumbs").innerText = "Windows Music Server";

    if (!LOCAL_PC_URL || !LOCAL_ACCOUNT_UUID) {
        container.innerHTML = `
            <div style='padding:20px; color:var(--text-dim); text-align:left; background: rgba(0,0,0,0.2); border-radius: 12px; margin-top: 10px;'>
                <h3 style="color: var(--primary); margin-top: 0; margin-bottom: 10px;">Library Setup Required</h3>
                <p style="font-size: 0.85rem; line-height: 1.4; color: white;">To link your PC library, follow these steps:</p>
                <ol style="font-size: 0.85rem; color: white; padding-left: 20px; line-height: 1.5; margin-bottom: 20px;">
                    <li>Open the <b>official Bose app</b>.</li>
                    <li>Play any track from your Computer Music Library.</li>
                    <li>While the song is playing, click the button below.</li>
                </ol>
                <button onclick="syncLocalLibrary()" style="background:var(--primary); color:#000; width:100%; padding:12px; border-radius:8px; border:none; font-weight:bold; box-shadow: 0 4px 10px rgba(0, 212, 255, 0.3);">
                    🔗 Link My Library Now
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = `<div style='padding:20px; color:var(--text-dim); text-align:center;'>Fetching ${tab} from PC...</div>`;

    try {
        const response = await fetch(`${LOCAL_PC_URL}/v1/${tab}?page=1`);
        const data = await response.json();
        let items = data._embedded[tab] || [];
        
        if (items.length === 0) {
            container.innerHTML = "<div style='padding:20px; color:var(--text-dim); text-align:center;'>No items found in this category.</div>";
            return;
        }

        let html = `
        <div style="display:flex; gap:10px; margin-bottom:15px; justify-content:center;">
            <button onclick="openLocalVault('albums')" style="background: ${tab==='albums'?'var(--primary)':'var(--btn-bg)'}; color: ${tab==='albums'?'#000':'white'}; border:none; padding:8px 15px; border-radius:8px; font-weight:bold;">Albums</button>
            <button onclick="openLocalVault('tracks')" style="background: ${tab==='tracks'?'var(--primary)':'var(--btn-bg)'}; color: ${tab==='tracks'?'#000':'white'}; border:none; padding:8px 15px; border-radius:8px; font-weight:bold;">All Tracks</button>
        </div>`;

        html += items.map(item => {
            const name = item.name.replace(/'/g, "\\'");
            const id = item.id;
            const playType = tab === 'albums' ? 'album' : 'track';
            const artUrl = item.imageURL ? item.imageURL : ''; 
            const artistName = (tab === 'tracks' && item._embedded && item._embedded.artist) ? item._embedded.artist.name : 'Local Media';
            const cleanArtistName = artistName === '##TRANS_UNKNOWNARTIST##' ? 'Unknown Artist' : artistName;
            const cleanItemName = item.name === '##TRANS_UNKNOWNALBUM##' ? 'Unknown Album' : item.name;

            const isAlbum = tab === 'albums';
            const onClickRow = isAlbum ? `onclick="openLocalAlbum('${id}', '${name}')" style="cursor:pointer;"` : '';

            return `
            <div class="search-item" style="display:flex; align-items:center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 10px; padding-left: 12px; padding-right: 12px; background: rgba(0,0,0,0.2); border-radius: 8px;">
                <div ${onClickRow} style="display:flex; flex:1; align-items:center; overflow:hidden;">
                    ${artUrl ? `<img src="${artUrl}" style="width:45px; height:45px; border-radius:6px; margin-right:12px; object-fit:cover;">` : `<div style="width:45px; height:45px; border-radius:6px; margin-right:12px; background:var(--btn-bg); display:flex; align-items:center; justify-content:center; font-size:1.2rem;">🎵</div>`}
                    <div style="flex:1; padding-right:10px; line-height:1.3; overflow:hidden;">
                        <strong style="color:white; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size: 0.95rem;">${cleanItemName}</strong>
                        <small style="color:var(--primary); font-size: 0.75rem;">${cleanArtistName}</small>
                    </div>
                </div>
                
                <button class="btn-icon btn-play" onclick="playLocalItem('${id}', '${name}', '${playType}')" style="flex-shrink: 0; margin-left: 5px;" title="Play ${isAlbum ? 'Album' : 'Track'}">
                    <svg class="svg-icon-small" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
            </div>`;
        }).join('');
        
        html += `<button onclick="disconnectLibrary()" style="background:transparent; color:#E74C3C; border:none; width:100%; padding:10px; font-size:0.75rem; margin-top:10px; text-decoration:underline;">Disconnect Library</button>`;
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div style='padding:20px; color:#E74C3C; text-align:center;'>Failed to load library. Ensure your SoundTouch PC App is running.</div>`;
    }
}

async function openLocalAlbum(albumId, albumName) {
    const container = document.getElementById("dlnaList");
    container.innerHTML = `<div style='padding:20px; color:var(--text-dim); text-align:center;'>Opening Album...</div>`;
    const cleanAlbumName = albumName === '##TRANS_UNKNOWNALBUM##' ? 'Unknown Album' : albumName;
    document.getElementById("dlnaBreadcrumbs").innerText = `Albums > ${cleanAlbumName}`;

    try {
        const response = await fetch(`${LOCAL_PC_URL}/v1/albums/${albumId}/tracks?page=1`);
        const data = await response.json();
        let items = data._embedded ? data._embedded.tracks : [];
        
        if (items.length === 0) {
            container.innerHTML = "<div style='padding:20px; color:var(--text-dim); text-align:center;'>No tracks found in this album.</div><button onclick=\"openLocalVault('albums')\" style=\"background:var(--btn-bg); color:white; width:100%; padding:10px; border-radius:8px; border:none; margin-top:10px;\">⬅ Back to Albums</button>";
            return;
        }

        let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding: 0 5px;">
            <button onclick="openLocalVault('albums')" style="background:transparent; color:var(--primary); border:1px solid var(--primary); padding:6px 12px; border-radius:6px; font-size:0.75rem; font-weight:bold;">⬅ Back</button>
            <button onclick="playLocalItem('${albumId}', '${albumName.replace(/'/g, "\\'")}', 'album')" style="background:var(--primary); color:#000; border:none; padding:6px 15px; border-radius:6px; font-weight:bold; font-size:0.75rem;">▶ Play Full Album</button>
        </div>`;

        html += items.map((item, index) => {
            const name = item.name.replace(/'/g, "\\'");
            const id = item.id;
            const trackNum = item.position || (index + 1);

            return `
            <div class="search-item" style="display:flex; align-items:center; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; padding-left: 10px; padding-right: 10px;">
                <div style="width:25px; color:var(--text-dim); font-size:0.8rem; font-weight:bold;">${trackNum}</div>
                <div style="flex:1; padding-right:10px; line-height:1.3; overflow:hidden;">
                    <strong style="color:white; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size: 0.9rem;">${item.name}</strong>
                </div>
                <button class="btn-icon btn-play" onclick="playLocalItem('${id}', '${name}', 'track')" style="flex-shrink: 0; width:32px; height:32px;">
                    <svg style="width:16px; height:16px;" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
            </div>`;
        }).join('');
        
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div style='padding:20px; color:#E74C3C; text-align:center;'>Failed to load album tracks.</div>`;
    }
}

async function playLocalItem(id, name, type) {
    if (!REST_URL) return;
    try {
        const cleanName = name === '##TRANS_UNKNOWNALBUM##' ? 'Unknown Album' : name;
        document.getElementById("ui-track").innerText = "Loading...";
        document.getElementById("ui-artist").innerText = cleanName;
        toggleModal('dlnaModal'); 
        
        const xml = `
            <ContentItem source="LOCAL_MUSIC" type="${type}" location="${type}:${id}" sourceAccount="${LOCAL_ACCOUNT_UUID}" isPresetable="true">
                <itemName>${name}</itemName>
            </ContentItem>
        `;
        
        await fetch(`${REST_URL}/select`, { method: 'POST', body: xml });
    } catch (e) { console.error("Playback failed", e); }
}

function disconnectLibrary() {
    if (confirm("Disconnect your local music library from this app?")) {
        localStorage.removeItem("bose_local_uuid");
        localStorage.removeItem("bose_local_pc_url");
        LOCAL_ACCOUNT_UUID = ""; LOCAL_PC_URL = "";
        openLocalVault(); 
    }
}

// ==========================================
// SECTION 11: TASKER & URL DEEP LINKING
// ==========================================

async function handleUrlCommands() {
    // Grab the URL parameters (e.g. ?scene=2&vol=40)
    const params = new URLSearchParams(window.location.search);
    if (!params.toString() || !REST_URL) return;

    showToast("⚙️ Executing Automation...");

    // 1. Play a Preset (e.g., ?preset=1)
    if (params.has('preset')) {
        const p = params.get('preset');
        const data = localStorage.getItem(`custom_p${p}`);
        if (data) {
            const preset = JSON.parse(data);
            if (preset.type === "SPOTIFY") {
                preset.id === "spotify_quick_resume" ? resumeSpotify() : castSpotifyGhostLink(preset.id);
            } else {
                document.getElementById("ui-track").innerText = "Tuning...";
                await fetch(`${REST_URL}/select`, { method: 'POST', body: `<ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/${preset.id}" sourceAccount=""><itemName>${preset.name}</itemName></ContentItem>` });
            }
        } else {
            // Fallback to hardware preset
            sendKey(`PRESET_${p}`);
        }
    } 
    // 2. Deploy a Scene (e.g., ?scene=3)
    else if (params.has('scene')) {
        const s = params.get('scene');
        const data = localStorage.getItem(`scene_p${s}`);
        if (data) executeScene(JSON.parse(data));
        else showToast(`❌ Scene ${s} not found!`);
    }
    // 3. Toggle Power (e.g., ?power=toggle)
    else if (params.has('power')) {
        togglePower();
    }
    // 4. Resume Spotify (e.g., ?spotify=resume)
    else if (params.has('spotify')) {
        resumeSpotify();
    }
    // 5. Play/Pause toggle (e.g., ?playpause=toggle)
    else if (params.has('playpause')) {
        togglePlayPause();
    }

    // 6. Volume Control (e.g., ?vol=up, ?vol=down, ?vol=40)
    // Note: Can be stacked with scenes! (e.g., ?preset=1&vol=20)
    if (params.has('vol')) {
        let v = params.get('vol');
        if (v === "up") changeVolume(5);
        else if (v === "down") changeVolume(-5);
        else if (!isNaN(parseInt(v))) {
            currentMasterVol = parseInt(v);
            fetch(`${REST_URL}/volume`, { method: 'POST', body: `<volume>${currentMasterVol}</volume>` });
        }
    }

    // Clean up the URL so refreshing the page doesn't run the automation twice!
    window.history.replaceState({}, document.title, window.location.pathname);
}