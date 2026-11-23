const { normalizeDb } = require("../../../src/helpers/overlay/commandMode/commandDb");
const { skillFromTemplate } = require("../../../src/helpers/overlay/appSkillStore");

function sampleCommandDbRaw() {
  return {
    version: 1,
    updatedAt: "2026-11-23T00:00:00.000Z",
    remoteUrl: "",
    apps: [
      {
        appId: "spotify",
        name: "Spotify",
        aliases: ["spotify"],
        match: {
          exe: ["spotify.exe"],
          aumidPrefix: ["SpotifyAB.SpotifyMusic_"],
          protocols: ["spotify"],
          nameRegex: "^Spotify$",
        },
        actions: [
          {
            id: "launch",
            description: "Open Spotify",
            params: [],
            how: { type: "cli", template: "{target}" },
            examples: [{ utterance: "open spotify", params: {} }],
            risk: "safe",
          },
          {
            id: "play_track",
            description: "Play a track or search in Spotify",
            params: [{ name: "query", type: "string", required: true }],
            how: { type: "uri", template: "spotify:search:{query}" },
            examples: [{ utterance: "play starboy on spotify", params: { query: "starboy" } }],
            risk: "safe",
          },
        ],
      },
      {
        appId: "gmail",
        name: "Gmail",
        aliases: ["gmail", "google mail"],
        alwaysAvailable: true,
        match: { nameRegex: "Gmail" },
        actions: [
          {
            id: "open",
            description: "Open Gmail",
            params: [],
            how: { type: "url", template: "https://mail.google.com/" },
            examples: [{ utterance: "open gmail", params: {} }],
            risk: "safe",
          },
        ],
      },
    ],
  };
}

function sampleCommandDb() {
  return normalizeDb(sampleCommandDbRaw());
}

function spotifySkill() {
  const db = sampleCommandDb();
  return skillFromTemplate(db.apps.find((app) => app.appId === "spotify"), {
    target: "C:\\\\Spotify\\\\Spotify.exe",
  });
}

module.exports = { sampleCommandDbRaw, sampleCommandDb, spotifySkill };
