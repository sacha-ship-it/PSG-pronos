"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const PARIS_PARTS = ms => Object.fromEntries(
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(ms))
    .filter(p => p.type !== "literal")
    .map(p => [p.type, p.value])
);

function formatDate(ms, language = "fr") {
  return new Intl.DateTimeFormat(
    language === "en" ? "en-GB" : "fr-FR",
    {
      timeZone: "Europe/Paris",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }
  ).format(new Date(ms));
}

const PSG_EMOJI = "<:psg:1389999731941310526>";
const PARIS_TZ = "Europe/Paris";
const MAX_PLAYER_PICKS = 3;

const POINTS = {
  outcome: 2,
  exactScore: 5,
  players: [0, 2, 3, 5],
  none: 2,
};

const PSG_SQUAD = [
  { name: "Achraf Hakimi", number: 2 },
  { name: "Lucas Beraldo", number: 4 },
  { name: "Marquinhos", number: 5 },
  { name: "Illia Zabarnyi", number: 6 },
  { name: "Khvicha Kvaratskhelia", number: 7 },
  { name: "Fabián Ruiz", number: 8 },
  { name: "Ferran", number: 9 },
  { name: "Ousmane Dembélé", number: 10 },
  { name: "Maghnes Akliouche", number: 11 },
  { name: "Lucas Digne", number: 12 },
  { name: "Désiré Doué", number: 14 },
  { name: "Alessandro Longoni", number: 16 },
  { name: "Vitinha", number: 17 },
  { name: "Lucas Hernández", number: 21 },
  { name: "Mika Godts", number: 22 },
  { name: "Senny Mayulu", number: 24 },
  { name: "Nuno Mendes", number: 25 },
  { name: "Dro Fernández", number: 27 },
  { name: "Lucas Chevalier", number: 30 },
  { name: "Warren Zaïre-Emery", number: 33 },
  { name: "Matvey Safonov", number: 39 },
  { name: "Quentin Ndjantou", number: 47 },
  { name: "Willian Pacho", number: 51 },
  { name: "João Neves", number: 87 },

  // Garder les ajouts en fin de liste.
  { name: "Adam Mouak", number: 80 },
  { name: "Arthur Bar", number: 90 },
  { name: "David Boly", number: null },
  { name: "Lucas Batbedat", number: null },
  { name: "Adam Ayari", number: null },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let matches = new Map();
let predictions = new Map();

const sessions = new Map();
const resultSessions = new Map();

let leaderboardMessage = null;
let leaderboardLanguage = "fr";
let leaderboardResetAt = 0;

let dataFile = null;
let lastDurable = null;
let storageFailed = false;
let timer = null;
let closing = false;

const quiet = { parse: [] };
const DEFAULT_MYPARIS_URL = "https://www.psg.fr/playzone";

function checkedURL(value) {
  const url = new URL(String(value).trim());

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.length > 512
  ) {
    throw new Error(
      "Utilise un lien HTTPS public, de 512 caractères maximum."
    );
  }

  return url.href;
}

function myParisURL(match) {
  return checkedURL(
    match?.myparisUrl ||
    process.env.MYPARIS_PREDICTOR_URL ||
    DEFAULT_MYPARIS_URL
  );
}

function myParisButton(match) {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setURL(myParisURL(match))
    .setLabel(
      tr(
        match.language,
        "Jouer aussi sur MyParis",
        "Play on MyParis too"
      )
    );
}

function snapshot() {
  return {
    schema: 1,
    matches: [...matches],
    predictions: [...predictions].map(
      ([mid, picks]) => [mid, [...picks]]
    ),
    leaderboardMessage,
    leaderboardLanguage,
    leaderboardResetAt,
  };
}

function hydrate(data) {
  if (
    data.schema !== 1 ||
    !Array.isArray(data.matches) ||
    !Array.isArray(data.predictions)
  ) {
    throw new Error(
      "Sauvegarde PSG illisible. Ne supprime pas le fichier."
    );
  }

  matches = new Map(data.matches);

  predictions = new Map(
    data.predictions.map(
      ([mid, picks]) => [mid, new Map(picks)]
    )
  );

  leaderboardMessage = data.leaderboardMessage || null;
  leaderboardLanguage = data.leaderboardLanguage || "fr";
  leaderboardResetAt = data.leaderboardResetAt || 0;

  for (const match of matches.values()) {
    match.squad ||= structuredClone(PSG_SQUAD);

    match.scoringVersion ||=
      match.status === "settled"
        ? "legacy"
        : "progressive";

    if (!predictions.has(match.id)) {
      predictions.set(match.id, new Map());
    }
  }
}

function persist() {
  if (storageFailed) {
    throw new Error(
      "Sauvegarde indisponible. Redémarre le bot après vérification du volume."
    );
  }

  if (!dataFile) {
    throw new Error("Stockage non initialisé.");
  }

  const data = snapshot();

  try {
    const fd = fs.openSync(
      dataFile + ".tmp",
      "w",
      0o600
    );

    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(dataFile)) {
      fs.copyFileSync(dataFile, dataFile + ".bak");
    }

    fs.renameSync(dataFile + ".tmp", dataFile);

    const directory = fs.openSync(
      path.dirname(dataFile),
      "r"
    );

    try {
      fs.fsyncSync(directory);
    } catch (error) {
      if (!["EINVAL", "ENOTSUP"].includes(error.code)) {
        throw error;
      }
    } finally {
      fs.closeSync(directory);
    }

    lastDurable = structuredClone(data);
  } catch (error) {
    if (lastDurable) {
      hydrate(lastDurable);
    }

    storageFailed = true;

    throw new Error(
      "Écriture sur le volume impossible. Les nouvelles opérations sont bloquées pour protéger les données."
    );
  }
}

function initStorage(env = process.env) {
  const directory = path.resolve(
    env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    "./data"
  );

  if (
    env.RAILWAY_ENVIRONMENT_ID &&
    !env.RAILWAY_VOLUME_MOUNT_PATH
  ) {
    throw new Error(
      "Attache un volume Railway au bot, avec le chemin /data."
    );
  }

  if (
    env.RAILWAY_VOLUME_MOUNT_PATH &&
    directory !== path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)
  ) {
    throw new Error(
      "DATA_DIR doit correspondre au chemin du volume Railway."
    );
  }

  fs.mkdirSync(directory, { recursive: true });
  dataFile = path.join(directory, "psg-data.json");
  storageFailed = false;

  if (fs.existsSync(dataFile)) {
    hydrate(
      JSON.parse(fs.readFileSync(dataFile, "utf8"))
    );

    lastDurable = structuredClone(snapshot());
  } else {
    hydrate({
      schema: 1,
      matches: [],
      predictions: [],
    });

    persist();
  }
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has("ManageGuild") ||
    (
      process.env.ADMIN_ROLE_ID &&
      interaction.member?.roles?.cache?.has(
        process.env.ADMIN_ROLE_ID
      )
    )
  );
}

function requireAdmin(interaction) {
  if (!isAdmin(interaction)) {
    throw new Error("Commande réservée au staff.");
  }
}

function parseParisDate(value) {
  const match = String(value).trim().match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/
  );

  if (!match) {
    throw new Error(
      "Format attendu : JJ/MM/AAAA HH:mm, heure de Paris."
    );
  }

  const [, day, month, year, hour, minute] = match;

  if (Number(hour) > 23 || Number(minute) > 59) {
    throw new Error("Heure invalide.");
  }

  const date = `${year}-${month}-${day}`;

  const utc = Date.parse(
    `${date}T${hour}:${minute}:00Z`
  );

  if (
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Date invalide.");
  }

  const candidates = [];

  for (
    let offset = -180;
    offset <= 180;
    offset += 30
  ) {
    const ms = utc + offset * 60000;
    const parts = PARIS_PARTS(ms);

    const formatted =
      `${parts.year}-${parts.month}-${parts.day} ` +
      `${parts.hour}:${parts.minute}`;

    if (formatted === `${date} ${hour}:${minute}`) {
      candidates.push(ms);
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      "Heure inexistante ou ambiguë au changement d’heure. Choisis un autre horaire."
    );
  }

  return candidates[0];
}

function parseScore(value) {
  const match = value.trim().match(
    /^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/
  );

  return match
    ? [Number(match[1]), Number(match[2])]
    : null;
}

function tr(language, french, english) {
  return language === "en" ? english : french;
}

function outcomeLabel(outcome, language = "fr") {
  const french = {
    win: "Victoire du PSG",
    draw: "Match nul",
    loss: "Défaite du PSG",
  };

  const english = {
    win: "PSG win",
    draw: "Draw",
    loss: "PSG lose",
  };

  return (
    language === "en" ? english : french
  )[outcome];
}

function getActualOutcome(
  homeGoals,
  awayGoals,
  homeTeam,
  awayTeam
) {
  const isPsg = team =>
    /psg|paris saint[- ]germain|paris sg/i.test(team);

  const homeIsPsg = isPsg(homeTeam);
  const awayIsPsg = isPsg(awayTeam);

  if (homeIsPsg === awayIsPsg) {
    throw new Error(
      "Ajoute « PSG » ou « Paris Saint-Germain » au nom de l’équipe du PSG."
    );
  }

  const psgGoals = homeIsPsg
    ? homeGoals
    : awayGoals;

  const otherGoals = homeIsPsg
    ? awayGoals
    : homeGoals;

  return psgGoals > otherGoals
    ? "win"
    : psgGoals < otherGoals
      ? "loss"
      : "draw";
}

function squadMenuOptions(
  match,
  page = 0,
  selected = []
) {
  return [
    ...match.squad
      .slice(page * 24, page * 24 + 24)
      .map((player, index) => ({
        label: `${
          player.number
            ? "#" + player.number
            : "Titi"
        } ${player.name}`.slice(0, 100),
        value: String(page * 24 + index),
        default: selected.includes(
          String(page * 24 + index)
        ),
      })),
    {
      label: tr(
        match.language,
        "Aucun buteur / passeur du PSG",
        "No PSG scorer / assist"
      ),
      value: "none",
      default: selected.includes("none"),
    },
  ];
}

function playerPayload(
  match,
  field,
  session,
  staff = false,
  page = 0
) {
  const pages = Math.ceil(match.squad.length / 24);

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1)
  );

  const selected = session[field] || [];
  const options = squadMenuOptions(
    match,
    page,
    selected
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      `psg:${staff ? "result-" : ""}${field}:${match.id}:${page}`
    )
    .setPlaceholder(
      tr(
        match.language,
        field === "scorers"
          ? "Choisis les buteurs"
          : "Choisis les passeurs",
        field === "scorers"
          ? "Select scorers"
          : "Select assists"
      )
    )
    .setMinValues(1)
    .setMaxValues(
      staff
        ? options.length
        : Math.min(3, options.length)
    )
    .addOptions(options);

  const mode = staff ? "1" : "0";

  const buttons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `psg:players-page:${match.id}:${field}:${page - 1}:${mode}`
        )
        .setLabel("←")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),

      new ButtonBuilder()
        .setCustomId(
          `psg:players-page:${match.id}:${field}:${page + 1}:${mode}`
        )
        .setLabel("→")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === pages - 1),

      new ButtonBuilder()
        .setCustomId(
          `psg:players-next:${match.id}:${field}:${mode}`
        )
        .setLabel(
          tr(match.language, "Continuer", "Continue")
        )
        .setStyle(ButtonStyle.Success)
    );

  return {
    content:
      `**${
        field === "scorers"
          ? tr(
              match.language,
              "Buteurs PSG",
              "PSG scorers"
            )
          : tr(
              match.language,
              "Passeurs PSG",
              "PSG assists"
            )
      } · ${page + 1}/${pages}**\n` +
      tr(
        match.language,
        staff
          ? "Sélectionne tous les joueurs concernés, puis Continuer."
          : "Choisis jusqu’à 3 joueurs au total, puis Continuer.",
        staff
          ? "Select all relevant players, then Continue."
          : "Select up to 3 players in total, then Continue."
      ) +
      "\n\n" +
      tr(
        match.language,
        "Sélection actuelle : ",
        "Current selection: "
      ) +
      (
        session[field]
          ? displayPlayers(
              selected,
              match.language,
              match.squad
            )
          : tr(
              match.language,
              "à compléter",
              "not selected"
            )
      ),
    components: [menuRow(menu), buttons],
  };
}

function mergePlayerSelection(
  match,
  current,
  values,
  page,
  staff = false
) {
  if (values.includes("none")) {
    if (values.length !== 1) {
      throw new Error("Choisis Aucun seul.");
    }

    return ["none"];
  }

  const allowed = new Set(
    match.squad
      .slice(page * 24, page * 24 + 24)
      .map((_, index) =>
        String(page * 24 + index)
      )
  );

  if (
    !values.length ||
    values.some(value => !allowed.has(value))
  ) {
    throw new Error("Sélection invalide.");
  }

  const next = [
    ...new Set([
      ...(current || []).filter(
        value =>
          value !== "none" &&
          !allowed.has(value)
      ),
      ...values,
    ]),
  ];

  if (!staff && next.length > 3) {
    throw new Error(
      "Maximum 3 joueurs au total, toutes pages confondues. Modifie ta sélection sur l’autre page."
    );
  }

  return next;
}

function menuRow(menu) {
  return new ActionRowBuilder().addComponents(menu);
}

function matchEmbed(match) {
  const kickoff = formatDate(
    match.kickoffAt,
    match.language
  );

  const closes = formatDate(
    match.closesAt,
    match.language
  );

  const english = match.language === "en";

  const intro = english
    ? `${PSG_EMOJI} **Your turn!**\nMake your prediction and climb the overall leaderboard 🏆\n\n`
    : `${PSG_EMOJI} **À toi de jouer !**\nFais ton pronostic et grimpe au classement général 🏆\n\n`;

  const schedule = english
    ? `🕒 Kick-off: **${kickoff}**\n🔒 Predictions close: **${closes}**\n\n🏆 The top players will be rewarded.`
    : `🕒 Coup d’envoi : **${kickoff}**\n🔒 Clôture des pronostics : **${closes}**\n\n🏆 Les meilleurs seront récompensés.`;

  const scoring = match.scoringVersion === "legacy"
    ? tr(
        match.language,
        "✅ Bon résultat : **+2 pts**\n" +
        "🎯 Score exact : **+5 pts**\n" +
        "⚽ Catégorie buteurs : **+3 pts**\n" +
        "👟 Catégorie passeurs : **+3 pts**",
        "✅ Correct result: **+2 pts**\n" +
        "🎯 Exact score: **+5 pts**\n" +
        "⚽ Scorers category: **+3 pts**\n" +
        "👟 Assists category: **+3 pts**"
      )
    : tr(
        match.language,
        `✅ Bon résultat : **+${POINTS.outcome} pts**\n` +
        `🎯 Score exact : **+${POINTS.exactScore} pts**\n` +
        "⚽ Buteurs trouvés : **1 = 2 pts | 2 = 3 pts | 3 = 5 pts**\n" +
        "👟 Passeurs trouvés : **1 = 2 pts | 2 = 3 pts | 3 = 5 pts**\n" +
        "👌 « Aucun » correct : **+2 pts** dans la catégorie concernée.\n" +
        "🏆 Maximum : **17 points par match**.",
        `✅ Correct result: **+${POINTS.outcome} pts**\n` +
        `🎯 Exact score: **+${POINTS.exactScore} pts**\n` +
        "⚽ Correct scorers: **1 = 2 pts | 2 = 3 pts | 3 = 5 pts**\n" +
        "👟 Correct assists: **1 = 2 pts | 2 = 3 pts | 3 = 5 pts**\n" +
        '👌 Correct "None": **+2 pts** for that category.\n' +
        "🏆 Maximum: **17 points per match**."
      );

  const embed = new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(
      `${match.homeTeam} vs ${match.awayTeam}`
    )
    .setDescription(
      intro +
      schedule +
      "\n\n" +
      tr(
        match.language,
        `🔴🔵 Prolonge le match sur MyParis : [participe aussi au Predictor dans la Playzone](${myParisURL(match)}) !`,
        `🔴🔵 Keep playing on MyParis: [try the Predictor in the Playzone too](${myParisURL(match)})!`
      )
    )
    .addFields({
      name: english ? "🎯 Scoring" : "🎯 Barème",
      value: scoring,
    })
    .setFooter({
      text: `PSG | ${match.id} | ${match.status}`,
    });

  if (match.imageUrl) {
    embed.setThumbnail(match.imageUrl);
  }

  return embed;
}

function matchButtons(matchId, language) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`psg:open:${matchId}`)
      .setLabel(
        tr(
          language,
          "Faire mon pronostic",
          "Make my prediction"
        )
      )
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`psg:view:${matchId}`)
      .setLabel(
        tr(
          language,
          "Voir mon pronostic",
          "View my prediction"
        )
      )
      .setStyle(ButtonStyle.Secondary),

    myParisButton(matches.get(matchId))
  );
}

async function logStaff(message) {
  if (!process.env.STATS_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(
      process.env.STATS_CHANNEL_ID
    );

    if (channel?.isTextBased()) {
      await channel.send({
        content: message,
        allowedMentions: quiet,
      });
    }
  } catch (error) {
    console.error(
      "Erreur dans le salon de stats :",
      error.message
    );
  }
}

async function setupMatch(interaction) {
  const language =
    interaction.commandName === "match-setup-en"
      ? "en"
      : "fr";

  const english = language === "en";

  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const homeTeam = interaction.options
      .getString(
        english ? "home_team" : "equipe_domicile"
      )
      .trim();

    const awayTeam = interaction.options
      .getString(
        english ? "away_team" : "equipe_exterieure"
      )
      .trim();

    const kickoff = parseParisDate(
      interaction.options.getString(
        english ? "kick_off" : "coup_denvoi"
      )
    );

    const closes = parseParisDate(
      interaction.options.getString(
        english ? "closing_time" : "cloture"
      )
    );

    if (
      homeTeam.toLocaleLowerCase("fr") ===
      awayTeam.toLocaleLowerCase("fr")
    ) {
      throw new Error(
        "Les équipes doivent être différentes."
      );
    }

    if (closes <= Date.now()) {
      throw new Error(
        "La clôture doit être dans le futur."
      );
    }

    if (closes > kickoff) {
      throw new Error(
        "La clôture doit être avant le coup d’envoi."
      );
    }

    const channelId =
      interaction.options.getChannel(
        english ? "channel" : "salon"
      )?.id ||
      process.env.PREDICTIONS_CHANNEL_ID;

    if (!channelId) {
      throw new Error(
        "Choisis le salon dans la commande ou configure PREDICTIONS_CHANNEL_ID."
      );
    }

    const channel = await client.channels.fetch(
      channelId
    );

    if (!channel?.isTextBased()) {
      throw new Error(
        "Le salon sélectionné n’est pas un salon texte."
      );
    }

    const imageUrl =
      interaction.options.getString("image_url");

    if (imageUrl) {
      let image;

      try {
        image = new URL(imageUrl);
      } catch {
        throw new Error("URL d’image invalide.");
      }

      if (image.protocol !== "https:") {
        throw new Error(
          "L’URL de l’image doit commencer par https://."
        );
      }
    }

    const id =
      `PSG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const match = {
      id,
      squad: structuredClone(PSG_SQUAD),
      scoringVersion: "progressive",
      myparisUrl: checkedURL(
        interaction.options.getString("myparis_url") ||
        process.env.MYPARIS_PREDICTOR_URL ||
        DEFAULT_MYPARIS_URL
      ),
      homeTeam,
      awayTeam,
      language,
      imageUrl,
      kickoffAt: kickoff,
      closesAt: closes,
      channelId,
      messageId: null,
      status: "open",
      resultHome: null,
      resultAway: null,
      actualScorers: [],
      actualAssisters: [],
    };

    getActualOutcome(
      0,
      0,
      homeTeam,
      awayTeam
    );

    matches.set(id, match);
    predictions.set(id, new Map());

    persist();

    await publishMatch(match);

    await logStaff(
      `🆕 Match prêt · ID \`${id}\` · **${homeTeam} vs ${awayTeam}** · Clôture ${formatDate(closes)} (Paris) · <#${channelId}>`
    );

    return interaction.editReply(
      `✅ Pronostics lancés dans <#${channelId}>. ID staff pour /match-result : \`${id}\``
    );
  } catch (error) {
    return interaction.editReply(
      (
        error.message ||
        "Impossible de créer le match."
      ) +
      " Si un ID a été créé, consulte /match-list avant de recommencer."
    );
  }
}

function sessionKey(matchId, userId) {
  return `${matchId}:${userId}`;
}

function getSession(interaction, matchId) {
  const session = sessions.get(
    sessionKey(matchId, interaction.user.id)
  );

  if (
    !session ||
    session.expiresAt < Date.now()
  ) {
    throw new Error(
      "Cette étape a expiré. Clique à nouveau sur « Faire mon pronostic »."
    );
  }

  return session;
}

function startPredictionPayload(match, userId) {
  sessions.set(
    sessionKey(match.id, userId),
    {
      outcome: null,
      scoreHome: null,
      scoreAway: null,
      scorers: null,
      assisters: null,
      expiresAt: Date.now() + 30 * 60000,
    }
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:outcome:${match.id}`)
    .addOptions(
      {
        label: tr(
          match.language,
          "Victoire du PSG",
          "PSG win"
        ),
        value: "win",
      },
      {
        label: tr(
          match.language,
          "Match nul",
          "Draw"
        ),
        value: "draw",
      },
      {
        label: tr(
          match.language,
          "Défaite du PSG",
          "PSG lose"
        ),
        value: "loss",
      }
    )
    .setPlaceholder(
      tr(
        match.language,
        "Quel sera le résultat du PSG ?",
        "What will the PSG result be?"
      )
    );

  return {
    content:
      `**${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `**1/4 · ${tr(match.language, "Résultat", "Result")}**\n` +
      tr(
        match.language,
        "Qui l’emporte ?",
        "Who will win?"
      ),
    components: [menuRow(menu)],
  };
}

function scoreModal(matchId, language = "fr") {
  return new ModalBuilder()
    .setCustomId(`psg:score:${matchId}`)
    .setTitle(
      tr(
        language,
        "Ton score exact",
        "Your exact score"
      )
    )
    .addComponents(
      menuRow(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel(
            tr(
              language,
              "Score domicile-extérieur, ex. 2-1",
              "Home-away score, e.g. 2-1"
            )
          )
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2-1")
          .setRequired(true)
          .setMaxLength(5)
      )
    );
}

function displayPlayers(
  players,
  language = "fr",
  squad = PSG_SQUAD
) {
  if (
    !players?.length ||
    players.includes("none")
  ) {
    return tr(language, "Aucun", "None");
  }

  return players
    .map(index => squad[Number(index)]?.name)
    .filter(Boolean)
    .join(", ");
}

function recapPayload(match, session) {
  const editMenu = new StringSelectMenuBuilder()
    .setCustomId(`psg:edit-field:${match.id}`)
    .setPlaceholder(
      tr(
        match.language,
        "Modifier une réponse avant validation",
        "Edit an answer before confirming"
      )
    )
    .addOptions(
      {
        label: tr(
          match.language,
          "Modifier le résultat",
          "Edit result"
        ),
        value: "outcome",
      },
      {
        label: tr(
          match.language,
          "Modifier le score exact",
          "Edit exact score"
        ),
        value: "score",
      },
      {
        label: tr(
          match.language,
          "Modifier les buteurs",
          "Edit scorers"
        ),
        value: "scorers",
      },
      {
        label: tr(
          match.language,
          "Modifier les passeurs",
          "Edit assists"
        ),
        value: "assisters",
      }
    );

  return {
    content:
      `**${PSG_EMOJI} ${tr(match.language, "Récapitulatif", "Summary")} · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `${tr(match.language, "Résultat", "Result")} : **${outcomeLabel(session.outcome, match.language)}**\n` +
      `${tr(match.language, "Score", "Score")} : **${session.scoreHome}-${session.scoreAway}**\n` +
      `${tr(match.language, "Buteur(s) PSG", "PSG scorer(s)")} : **${displayPlayers(session.scorers, match.language, match.squad)}**\n` +
      `${tr(match.language, "Passeur(s) PSG", "PSG assists")} : **${displayPlayers(session.assisters, match.language, match.squad)}**\n\n` +
      tr(
        match.language,
        "Modifie une réponse si besoin, puis valide. Après validation, ton prono ne pourra plus être changé.",
        "Edit any answer if needed, then confirm. Once confirmed, your prediction cannot be changed."
      ),
    components: [
      menuRow(editMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`psg:confirm:${match.id}`)
          .setLabel(
            tr(
              match.language,
              "Valider mon pronostic",
              "Confirm my prediction"
            )
          )
          .setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

async function openPrediction(interaction, matchId) {
  const match = matches.get(matchId);

  if (
    !match ||
    match.status !== "open" ||
    Date.now() >= match.closesAt
  ) {
    return interaction.reply({
      content: "🔒 Les pronostics sont clôturés.",
      ephemeral: true,
    });
  }

  const existing = predictions
    .get(matchId)
    ?.get(interaction.user.id);

  if (existing) {
    return interaction.reply({
      content:
        "✅ Tu as déjà validé ton pronostic. Il n’est plus modifiable. Utilise **Voir mon pronostic** pour le consulter.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    ...startPredictionPayload(
      match,
      interaction.user.id
    ),
    ephemeral: true,
  });
}

function validateMulti(values) {
  if (
    values.includes("none") &&
    values.length > 1
  ) {
    return false;
  }

  return (
    values.length >= 1 &&
    values.length <= MAX_PLAYER_PICKS
  );
}

async function handleSelect(
  interaction,
  type,
  matchId
) {
  const match = matches.get(matchId);
  const session = getSession(
    interaction,
    matchId
  );

  if (!match) {
    throw new Error("Match introuvable.");
  }

  requireOpen(match, interaction.user.id);

  if (type === "outcome") {
    session.outcome = interaction.values[0];

    if (
      session.scorers &&
      session.assisters &&
      session.scoreHome !== null
    ) {
      return interaction.update(
        recapPayload(match, session)
      );
    }

    return interaction.update({
      content:
        `✅ Résultat choisi : **${outcomeLabel(session.outcome)}**\n\n` +
        "**2/4 · Score exact**",
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(
              `psg:score-open:${matchId}`
            )
            .setLabel("Saisir le score")
            .setEmoji("🔢")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });
  }

  if (type === "edit-field") {
    const field = interaction.values[0];

    if (field === "outcome") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`psg:outcome:${matchId}`)
        .setPlaceholder("Choisis le résultat")
        .addOptions(
          {
            label: "Victoire du PSG",
            value: "win",
            emoji: "🔴",
          },
          {
            label: "Match nul",
            value: "draw",
            emoji: "🤝",
          },
          {
            label: "Défaite du PSG",
            value: "loss",
            emoji: "🔵",
          }
        );

      return interaction.update({
        content: "✏️ Modifie ton résultat :",
        components: [menuRow(menu)],
      });
    }

    if (field === "score") {
      return interaction.showModal(
        scoreModal(matchId)
      );
    }

    if (
      field === "scorers" ||
      field === "assisters"
    ) {
      return interaction.update(
        playerPayload(match, field, session)
      );
    }
  }
}

async function scoreSubmitted(
  interaction,
  matchId
) {
  const session = getSession(
    interaction,
    matchId
  );

  requireOpen(
    matches.get(matchId),
    interaction.user.id
  );

  const score = parseScore(
    interaction.fields.getTextInputValue("score")
  );

  if (!score) {
    return interaction.reply({
      content:
        "Format incorrect. Entre le score comme `2-1`.",
      ephemeral: true,
    });
  }

  [
    session.scoreHome,
    session.scoreAway,
  ] = score;

  const match = matches.get(matchId);

  if (session.scorers && session.assisters) {
    return interaction.update(
      recapPayload(match, session)
    );
  }

  return interaction.update(
    playerPayload(match, "scorers", session)
  );
}

async function savePrediction(
  interaction,
  matchId
) {
  const match = matches.get(matchId);
  const session = getSession(
    interaction,
    matchId
  );

  if (
    !match ||
    match.status !== "open" ||
    Date.now() >= match.closesAt
  ) {
    sessions.delete(
      sessionKey(matchId, interaction.user.id)
    );

    return interaction.update({
      content:
        "🔒 La clôture est passée. Ton prono n’a pas été enregistré.",
      components: [],
    });
  }

  if (
    predictions.get(matchId)?.has(
      interaction.user.id
    )
  ) {
    sessions.delete(
      sessionKey(matchId, interaction.user.id)
    );

    return interaction.update({
      content:
        "Tu as déjà validé un prono pour ce match. Il ne peut plus être modifié.",
      components: [],
    });
  }

  if (!validPick(session, match)) {
    throw new Error(
      "Complète les quatre étapes avant de valider."
    );
  }

  predictions.get(matchId).set(
    interaction.user.id,
    {
      userId: interaction.user.id,
      outcome: session.outcome,
      scoreHome: session.scoreHome,
      scoreAway: session.scoreAway,
      scorers: session.scorers,
      assisters: session.assisters,
      points: 0,
    }
  );

  sessions.delete(
    sessionKey(matchId, interaction.user.id)
  );

  persist();

  await interaction.update({
    content:
      `✅ **Pronostic validé !** Bonne chance, supporter parisien. ${PSG_EMOJI}\n\n` +
      `🔴🔵 [Participe aussi au Predictor MyParis](${myParisURL(match)})`,
    components: [],
  });

  await logStaff(
    `📝 Prono validé · Match \`${matchId}\` · <@${interaction.user.id}> · ${outcomeLabel(session.outcome)} · ${session.scoreHome}-${session.scoreAway} · Buteurs : ${displayPlayers(session.scorers, match.language, match.squad)} · Passeurs : ${displayPlayers(session.assisters, match.language, match.squad)}`
  );
}

async function viewPrediction(
  interaction,
  matchId
) {
  const match = matches.get(matchId);

  const pick = predictions
    .get(matchId)
    ?.get(interaction.user.id);

  if (!match || !pick) {
    return interaction.reply({
      content:
        "Tu n’as pas encore validé de pronostic pour ce match.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    content:
      `**${PSG_EMOJI} Ton pronostic · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `🎯 Résultat : **${outcomeLabel(pick.outcome)}**\n` +
      `🔢 Score : **${pick.scoreHome}-${pick.scoreAway}**\n` +
      `⚽ Buteur(s) : **${displayPlayers(pick.scorers, match.language, match.squad)}**\n` +
      `👟 Passeur(s) : **${displayPlayers(pick.assisters, match.language, match.squad)}**\n\n` +
      (
        match.status === "settled"
          ? `🏆 Points gagnés : **${pick.points} pts**`
          : "🔒 Prono validé et verrouillé."
      ),
    ephemeral: true,
  });
}

function categoryPoints(
  selected,
  actual,
  version = "progressive"
) {
  if (
    !Array.isArray(selected) ||
    !selected.length
  ) {
    return 0;
  }

  const actualPlayers = new Set(actual || []);
  actualPlayers.delete("none");

  if (selected.includes("none")) {
    return (
      selected.length === 1 &&
      actualPlayers.size === 0
    )
      ? (
          version === "legacy"
            ? 3
            : POINTS.none
        )
      : 0;
  }

  const hits = [...new Set(selected)]
    .filter(player => actualPlayers.has(player))
    .length;

  return version === "legacy"
    ? (hits ? 3 : 0)
    : POINTS.players[Math.min(hits, 3)];
}

function leaderboardRows() {
  const table = new Map();

  for (
    const [matchId, matchPicks]
    of predictions
  ) {
    const match = matches.get(matchId);

    if (
      !match ||
      match.status !== "settled" ||
      (match.settledAt || 0) <= leaderboardResetAt
    ) {
      continue;
    }

    for (const pick of matchPicks.values()) {
      const row = table.get(pick.userId) || {
        userId: pick.userId,
        points: 0,
        matches: 0,
      };

      row.points += pick.points;
      row.matches += 1;

      table.set(pick.userId, row);
    }
  }

  return [...table.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.matches - a.matches ||
      a.userId.localeCompare(b.userId)
  );
}

function leaderboardEmbed(language = "fr") {
  const rows = leaderboardRows();

  const description = rows.length
    ? rows
        .slice(0, 10)
        .map(
          (row, index) =>
            `**${index + 1}.** <@${row.userId}> - **${row.points} pts**`
        )
        .join("\n")
    : tr(
        language,
        "Le classement apparaîtra après le premier match réglé.",
        "The leaderboard will appear after the first match is settled."
      );

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(
      tr(
        language,
        "CLASSEMENT GÉNÉRAL",
        "OVERALL LEADERBOARD"
      )
    )
    .setDescription(
      `${description}\n\n🏆 ` +
      tr(
        language,
        "Les meilleurs seront récompensés.",
        "The top players will be rewarded."
      )
    )
    .setFooter({
      text: tr(
        language,
        "Top 10 · Clique pour voir ta position",
        "Top 10 · Click to see your rank"
      ),
    })
    .setTimestamp();
}

async function updateLeaderboard(interaction) {
  requireAdmin(interaction);

  await interaction.deferReply({
    ephemeral: true,
  });

  if (!process.env.LEADERBOARD_CHANNEL_ID) {
    return interaction.editReply(
      "Ajoute LEADERBOARD_CHANNEL_ID dans Railway."
    );
  }

  const channel = await client.channels
    .fetch(process.env.LEADERBOARD_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) {
    return interaction.editReply(
      "LEADERBOARD_CHANNEL_ID ne correspond pas à un salon texte."
    );
  }

  const language =
    interaction.commandName === "leaderboard"
      ? "en"
      : "fr";

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("psg:rank:me")
        .setLabel(
          tr(
            language,
            "Voir ma position",
            "See my rank"
          )
        )
        .setStyle(ButtonStyle.Primary)
    ),
  ];

  try {
    if (
      leaderboardMessage?.channelId === channel.id
    ) {
      const oldMessage = await channel.messages
        .fetch(leaderboardMessage.id)
        .catch(() => null);

      if (oldMessage) {
        await oldMessage.edit({
          embeds: [leaderboardEmbed(language)],
          components,
        });
      } else {
        const sent = await channel.send({
          embeds: [leaderboardEmbed(language)],
          components,
        });

        leaderboardMessage = {
          channelId: channel.id,
          id: sent.id,
        };
      }
    } else {
      const sent = await channel.send({
        embeds: [leaderboardEmbed(language)],
        components,
      });

      leaderboardMessage = {
        channelId: channel.id,
        id: sent.id,
      };
    }

    leaderboardLanguage = language;
    persist();

    return interaction.editReply(
      tr(
        language,
        "Classement général publié / actualisé.",
        "Overall leaderboard published / refreshed."
      )
    );
  } catch (error) {
    console.error("Opération :", error.message);

    return interaction.editReply(
      "Je n’ai pas pu publier le classement. Vérifie mes permissions dans ce salon."
    );
  }
}

async function showMyRank(interaction) {
  const rows = leaderboardRows();

  const index = rows.findIndex(
    row => row.userId === interaction.user.id
  );

  if (index < 0) {
    return interaction.reply({
      content:
        "Tu n’as pas encore de points au classement. Tes points apparaîtront après un match terminé.",
      ephemeral: true,
    });
  }

  const row = rows[index];
  const tenth = rows[9];

  const gap =
    index >= 10 && tenth
      ? Math.max(0, tenth.points - row.points)
      : 0;

  const positionText = index < 10
    ? `Tu es **${index + 1}${index === 0 ? "er" : "e"}** avec **${row.points} points**. Tu es dans le top 10 ! 🔥`
    : `Tu es **${index + 1}e** avec **${row.points} points**. Il te manque **${gap} point(s)** pour rejoindre le top 10. 💪`;

  return interaction.reply({
    content:
      "📍 **Ta position au classement général**\n" +
      positionText,
    ephemeral: true,
  });
}

async function requestLeaderboardReset(
  interaction
) {
  requireAdmin(interaction);

  return interaction.reply({
    content:
      "Cette action remet à zéro les points du classement actuel. Les pronostics et résultats des matchs restent sauvegardés sur le volume. Confirmer ?",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("psg:reset-confirm")
          .setLabel(
            "Confirmer la réinitialisation"
          )
          .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
          .setCustomId("psg:reset-cancel")
          .setLabel("Annuler")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
    ephemeral: true,
  });
}

async function applyLeaderboardReset(
  interaction
) {
  requireAdmin(interaction);

  leaderboardResetAt = Date.now();
  persist();

  if (leaderboardMessage) {
    const channel = await client.channels
      .fetch(leaderboardMessage.channelId)
      .catch(() => null);

    const message = channel?.isTextBased()
      ? await channel.messages
          .fetch(leaderboardMessage.id)
          .catch(() => null)
      : null;

    if (message) {
      await message.edit({
        embeds: [
          leaderboardEmbed(
            leaderboardLanguage
          ),
        ],
      }).catch(() => {});
    }
  }

  return interaction.update({
    content:
      "Classement réinitialisé. Les prochains résultats commenceront un nouveau classement.",
    components: [],
  });
}

async function beginResult(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  const matchId = interaction.options
    .getString("match_id")
    .trim()
    .toUpperCase();

  const match = matches.get(matchId);

  if (
    !match ||
    match.status === "cancelled"
  ) {
    return interaction.reply({
      content: "Match introuvable ou annulé.",
      ephemeral: true,
    });
  }

  if (
    match.status === "settled" &&
    (match.settledAt || 0) <= leaderboardResetAt
  ) {
    return interaction.reply({
      content:
        "Ce match appartient à un classement déjà réinitialisé et ne peut plus être modifié.",
      ephemeral: true,
    });
  }

  const score = parseScore(
    interaction.options.getString("score")
  );

  if (!score) {
    return interaction.reply({
      content:
        "Format de score attendu : 2-1 (domicile-extérieur).",
      ephemeral: true,
    });
  }

  const [homeGoals, awayGoals] = score;

  try {
    getActualOutcome(
      homeGoals,
      awayGoals,
      match.homeTeam,
      match.awayTeam
    );
  } catch (error) {
    return interaction.reply({
      content: error.message,
      ephemeral: true,
    });
  }

  if (Date.now() < match.closesAt) {
    throw new Error(
      "Attends la clôture des pronostics pour saisir le résultat."
    );
  }

  resultSessions.set(
    sessionKey(matchId, interaction.user.id),
    {
      homeGoals,
      awayGoals,
      resetAt: leaderboardResetAt,
      resultVersion: match.resultVersion || 0,
      scorers: null,
      assisters: null,
      expiresAt: Date.now() + 30 * 60000,
    }
  );

  return interaction.reply({
    ...playerPayload(
      match,
      "scorers",
      resultSessions.get(
        sessionKey(
          matchId,
          interaction.user.id
        )
      ),
      true
    ),
    ephemeral: true,
  });
}

async function finishResult(
  interaction,
  matchId
) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  const match = matches.get(matchId);

  const key = sessionKey(
    matchId,
    interaction.user.id
  );

  const result = resultSessions.get(key);

  if (
    !match ||
    !result ||
    result.expiresAt < Date.now()
  ) {
    return interaction.reply({
      content:
        "Cette saisie de résultat a expiré. Relance /match-result.",
      ephemeral: true,
    });
  }

  if (
    match.status === "settled" &&
    (match.settledAt || 0) <= leaderboardResetAt
  ) {
    return interaction.update({
      content:
        "Ce match appartient à un classement déjà réinitialisé.",
      components: [],
    });
  }

  if (match.status === "cancelled") {
    throw new Error("Ce match est annulé.");
  }

  if (
    result.resetAt !== leaderboardResetAt ||
    result.resultVersion !==
      (match.resultVersion || 0)
  ) {
    throw new Error(
      "Le classement ou le résultat a changé. Relance /match-result."
    );
  }

  if (
    !validPlayers(
      result.scorers,
      match,
      true
    ) ||
    !validPlayers(
      result.assisters,
      match,
      true
    )
  ) {
    throw new Error(
      "Complète les buteurs et passeurs."
    );
  }

  const actualScorers =
    result.scorers.includes("none")
      ? []
      : result.scorers;

  const actualAssisters =
    result.assisters.includes("none")
      ? []
      : result.assisters;

  const actualOutcome = getActualOutcome(
    result.homeGoals,
    result.awayGoals,
    match.homeTeam,
    match.awayTeam
  );

  const picks =
    predictions.get(matchId) ||
    new Map();

  for (const pick of picks.values()) {
    let points =
      pick.outcome === actualOutcome
        ? POINTS.outcome
        : 0;

    if (
      pick.scoreHome === result.homeGoals &&
      pick.scoreAway === result.awayGoals
    ) {
      points += POINTS.exactScore;
    }

    points += categoryPoints(
      pick.scorers,
      actualScorers,
      match.scoringVersion
    );

    points += categoryPoints(
      pick.assisters,
      actualAssisters,
      match.scoringVersion
    );

    pick.points = points;
  }

  match.status = "settled";
  match.resultHome = result.homeGoals;
  match.resultAway = result.awayGoals;
  match.actualScorers = actualScorers;
  match.actualAssisters = actualAssisters;
  match.settledAt = Date.now();
  match.resultVersion =
    (match.resultVersion || 0) + 1;

  match.dirty = true;
  persist();

  resultSessions.delete(key);

  const scorerNames = displayPlayers(
    actualScorers,
    match.language,
    match.squad
  );

  const assisterNames = displayPlayers(
    actualAssisters,
    match.language,
    match.squad
  );

  await logStaff(
    `Résultat enregistré · ID \`${matchId}\` · ${match.homeTeam} ${result.homeGoals}-${result.awayGoals} ${match.awayTeam} · Buteurs : ${scorerNames} · Passeurs : ${assisterNames}`
  );

  return interaction.update({
    content: tr(
      match.language,
      `Résultat enregistré : **${result.homeGoals}-${result.awayGoals}**. Les pronostics sont notés. Lance /classement pour publier la mise à jour.`,
      `Result saved: **${result.homeGoals}-${result.awayGoals}**. Predictions are scored. Run /leaderboard to publish the update.`
    ),
    components: [],
  });
}

async function cancelMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  const matchId = interaction.options
    .getString("match_id")
    .trim()
    .toUpperCase();

  const match = matches.get(matchId);

  if (
    !match ||
    !["open", "closed"].includes(match.status)
  ) {
    return interaction.reply({
      content:
        "Match introuvable ou déjà réglé.",
      ephemeral: true,
    });
  }

  match.status = "cancelled";
  match.dirty = true;
  persist();

  const channel = await client.channels
    .fetch(match.channelId)
    .catch(() => null);

  const message =
    channel?.isTextBased() &&
    match.messageId
      ? await channel.messages
          .fetch(match.messageId)
          .catch(() => null)
      : null;

  if (message) {
    const cancelled =
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("psg:cancelled")
          .setLabel("Match annulé")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );

    await message.edit({
      embeds: [
        EmbedBuilder
          .from(message.embeds[0])
          .setFooter({
            text: "Match annulé",
          }),
      ],
      components: [
        cancelled,
        menuRow(myParisButton(match)),
      ],
    }).catch(() => {});
  }

  await logStaff(
    `🚫 Match annulé · ID \`${matchId}\` · ${match.homeTeam} vs ${match.awayTeam}`
  );

  return interaction.reply({
    content: `Match \`${matchId}\` annulé.`,
    ephemeral: true,
  });
}

async function closeExpiredMatches() {
  for (const match of matches.values()) {
    if (
      match.status !== "open" ||
      Date.now() < match.closesAt
    ) {
      continue;
    }

    match.status = "closed";
    match.dirty = true;
    persist();

    const channel = await client.channels
      .fetch(match.channelId)
      .catch(() => null);

    const message =
      channel?.isTextBased() &&
      match.messageId
        ? await channel.messages
            .fetch(match.messageId)
            .catch(() => null)
        : null;

    if (message) {
      const closed =
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("psg:closed")
            .setLabel(
              tr(
                match.language,
                "Pronostics clôturés",
                "Predictions closed"
              )
            )
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),

          new ButtonBuilder()
            .setCustomId(
              `psg:view:${match.id}`
            )
            .setLabel(
              tr(
                match.language,
                "Voir mon pronostic",
                "View my prediction"
              )
            )
            .setStyle(ButtonStyle.Secondary)
        );

      await message.edit({
        embeds: [
          EmbedBuilder
            .from(message.embeds[0])
            .setFooter({
              text: tr(
                match.language,
                "Pronostics clôturés",
                "Predictions closed"
              ),
            }),
        ],
        components: [
          closed,
          menuRow(myParisButton(match)),
        ],
      }).catch(error =>
        console.error(
          "Fermeture du message impossible :",
          error.message
        )
      );
    }

    await logStaff(
      `🔒 Pronostics clôturés · ID \`${match.id}\` · ${match.homeTeam} vs ${match.awayTeam}`
    );
  }
}

function validPlayers(
  values,
  match,
  staff = false
) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    new Set(values).size !== values.length
  ) {
    return false;
  }

  if (values.includes("none")) {
    return values.length === 1;
  }

  return (
    (staff || values.length <= MAX_PLAYER_PICKS) &&
    values.every(
      value =>
        /^(0|[1-9]\d*)$/.test(value) &&
        Number(value) < match.squad.length
    )
  );
}

function validPick(pick, match) {
  return (
    ["win", "draw", "loss"].includes(
      pick.outcome
    ) &&
    Number.isInteger(pick.scoreHome) &&
    Number.isInteger(pick.scoreAway) &&
    pick.scoreHome >= 0 &&
    pick.scoreHome <= 99 &&
    pick.scoreAway >= 0 &&
    pick.scoreAway <= 99 &&
    validPlayers(pick.scorers, match) &&
    validPlayers(pick.assisters, match)
  );
}

function requireOpen(match, userId) {
  if (
    !match ||
    match.status !== "open" ||
    Date.now() >= match.closesAt
  ) {
    throw new Error(
      "Les pronostics sont clôturés."
    );
  }

  if (
    predictions.get(match.id)?.has(userId)
  ) {
    throw new Error(
      "Ton pronostic est déjà validé. Clique sur Voir mon pronostic."
    );
  }
}

function resultRecap(match, session) {
  return {
    content:
      `**${tr(match.language, "Résultat à confirmer", "Confirm result")}**\n` +
      `${match.homeTeam} ${session.homeGoals}-${session.awayGoals} ${match.awayTeam}\n` +
      `⚽ ${displayPlayers(session.scorers, match.language, match.squad)}\n` +
      `👟 ${displayPlayers(session.assisters, match.language, match.squad)}`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `psg:result-confirm:${match.id}`
          )
          .setLabel(
            tr(
              match.language,
              "Confirmer le résultat",
              "Confirm result"
            )
          )
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(
            `psg:result-cancel:${match.id}`
          )
          .setLabel(
            tr(
              match.language,
              "Annuler",
              "Cancel"
            )
          )
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

async function playerButtons(
  interaction,
  action,
  args
) {
  const [matchId, field] = args;
  const match = matches.get(matchId);

  const staff = (
    action === "players-page"
      ? args[3]
      : args[2]
  ) === "1";

  if (staff) {
    requireAdmin(interaction);
  }

  const session = staff
    ? resultSessions.get(
        sessionKey(
          matchId,
          interaction.user.id
        )
      )
    : getSession(interaction, matchId);

  if (
    !match ||
    !session ||
    session.expiresAt < Date.now() ||
    !["scorers", "assisters"].includes(field)
  ) {
    throw new Error(
      "Cette étape a expiré."
    );
  }

  if (!staff) {
    requireOpen(
      match,
      interaction.user.id
    );
  }

  if (action === "players-page") {
    return interaction.update(
      playerPayload(
        match,
        field,
        session,
        staff,
        Number(args[2])
      )
    );
  }

  if (
    !validPlayers(
      session[field],
      match,
      staff
    )
  ) {
    throw new Error(
      "Sélectionne au moins un joueur ou Aucun avant de continuer."
    );
  }

  if (
    field === "scorers" &&
    !session.assisters
  ) {
    return interaction.update(
      playerPayload(
        match,
        "assisters",
        session,
        staff
      )
    );
  }

  return interaction.update(
    staff
      ? resultRecap(match, session)
      : recapPayload(match, session)
  );
}

async function publishMatch(match) {
  const channel = await client.channels.fetch(
    match.channelId
  );

  if (
    !channel?.isTextBased() ||
    channel.guildId !== process.env.DISCORD_GUILD_ID
  ) {
    throw new Error("Salon inaccessible.");
  }

  let message = null;

  if (match.messageId) {
    try {
      message = await channel.messages.fetch(
        match.messageId
      );
    } catch (error) {
      if (error.code !== 10008) {
        throw error;
      }

      return;
    }
  } else {
    if (!match.sendStartedAt) {
      match.sendStartedAt = Date.now();
      persist();
    }

    let before;

    for (let index = 0; index < 100; index++) {
      const recent = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!recent.size) break;

      message = recent.find(
        item =>
          item.author.id === client.user.id &&
          item.embeds.some(
            embed =>
              embed.footer?.text?.startsWith(
                `PSG | ${match.id} |`
              )
          )
      );

      if (
        message ||
        recent.last().createdTimestamp <
          match.sendStartedAt - 10000
      ) {
        break;
      }

      if (index === 99) {
        throw new Error(
          "Historique trop long pour vérifier l’envoi, publication suspendue."
        );
      }

      before = recent.last().id;
    }
  }

  const buttons = matchButtons(
    match.id,
    match.language
  );

  if (
    match.status !== "open" ||
    Date.now() >= match.closesAt
  ) {
    buttons.components[0].setDisabled(true);
  }

  if (match.status === "cancelled") {
    buttons.components[1].setDisabled(true);
  }

  const payload = {
    embeds: [matchEmbed(match)],
    components: [buttons],
    allowedMentions: quiet,
  };

  if (message) {
    await message.edit(payload);
  } else {
    const nonce = BigInt(
      "0x" +
      crypto
        .createHash("sha256")
        .update(match.id)
        .digest("hex")
        .slice(0, 16)
    ).toString();

    message = await channel.send({
      ...payload,
      nonce,
      enforceNonce: true,
    });
  }

  match.messageId = message.id;

  match.dirty =
    JSON.stringify(
      matchEmbed(match).toJSON()
    ) !==
    JSON.stringify(
      payload.embeds[0].toJSON()
    );

  persist();
}

async function tick() {
  if (closing || storageFailed) return;

  closing = true;

  try {
    await closeExpiredMatches();

    for (const match of matches.values()) {
      if (
        match.dirty ||
        !match.messageId
      ) {
        try {
          await publishMatch(match);
        } catch (error) {
          console.error(
            `Publication ${match.id} :`,
            error.message
          );
        }
      }
    }

    for (
      const table
      of [sessions, resultSessions]
    ) {
      for (const [key, value] of table) {
        if (value.expiresAt < Date.now()) {
          table.delete(key);
        }
      }
    }
  } finally {
    closing = false;
  }
}

async function staffTools(interaction) {
  requireAdmin(interaction);

  await interaction.deferReply({
    ephemeral: true,
  });

  if (
    interaction.commandName === "diagnostic"
  ) {
    return interaction.editReply(
      `✅ Sauvegarde : ${dataFile}\n` +
      `Matchs : ${matches.size}\n` +
      `Pronostics : ${
        [...predictions.values()].reduce(
          (count, picks) => count + picks.size,
          0
        )
      }\n` +
      `Joueurs proposés : ${PSG_SQUAD.length}\n` +
      "Heure : Europe/Paris\n" +
      `MyParis : ${myParisURL()}`
    );
  }

  if (
    interaction.commandName === "match-list"
  ) {
    const lines = [...matches.values()].map(
      match =>
        `${match.id} | ${match.homeTeam} vs ${match.awayTeam} | ${match.status} | ${formatDate(match.closesAt)}`
    );

    return interaction.editReply({
      content:
        lines.slice(-8).join("\n") ||
        "Aucun match.",
      files: lines.length
        ? [
            new AttachmentBuilder(
              Buffer.from(lines.join("\n")),
              { name: "matchs.txt" }
            ),
          ]
        : [],
    });
  }

  const csv = value =>
    '"' +
    String(value ?? "")
      .replaceAll('"', '""')
      .replace(/^[=+\-@]/, "'$&") +
    '"';

  const rows = [
    ["rang", "discord_id", "points", "matchs"],
    ...leaderboardRows().map(
      (row, index) => [
        index + 1,
        row.userId,
        row.points,
        row.matches,
      ]
    ),
  ];

  return interaction.editReply({
    content:
      "Sauvegarde complète et classement exportés. Garde ces fichiers côté staff.",
    files: [
      new AttachmentBuilder(
        Buffer.from(
          JSON.stringify(snapshot(), null, 2)
        ),
        { name: "psg-sauvegarde.json" }
      ),
      new AttachmentBuilder(
        Buffer.from(
          "\uFEFF" +
          rows
            .map(row => row.map(csv).join(";"))
            .join("\r\n")
        ),
        { name: "classement-psg.csv" }
      ),
    ],
  });
}

function commands() {
  return [
    new SlashCommandBuilder()
      .setName("match-setup")
      .setDescription(
        "Créer le post pronostics d’un match"
      )
      .addStringOption(option =>
        option
          .setName("equipe_domicile")
          .setDescription("Ex. PSG")
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption(option =>
        option
          .setName("equipe_exterieure")
          .setDescription("Ex. Lyon")
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption(option =>
        option
          .setName("coup_denvoi")
          .setDescription(
            "Heure de Paris : JJ/MM/AAAA HH:mm"
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("cloture")
          .setDescription(
            "Heure de Paris : JJ/MM/AAAA HH:mm"
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("image_url")
          .setDescription(
            "URL HTTPS de l’image affichée en haut à droite"
          )
          .setRequired(false)
          .setMaxLength(500)
      )
      .addStringOption(option =>
        option
          .setName("myparis_url")
          .setDescription(
            "Lien du Predictor MyParis de ce match, facultatif"
          )
          .setMaxLength(512)
      )
      .addChannelOption(option =>
        option
          .setName("salon")
          .setDescription(
            "Salon des pronostics"
          )
          .addChannelTypes(
            ChannelType.GuildText
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("match-setup-en")
      .setDescription(
        "Create a match prediction post in English"
      )
      .addStringOption(option =>
        option
          .setName("home_team")
          .setDescription(
            "Home team, e.g. PSG"
          )
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption(option =>
        option
          .setName("away_team")
          .setDescription(
            "Away team, e.g. Lyon"
          )
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption(option =>
        option
          .setName("kick_off")
          .setDescription(
            "Paris time: DD/MM/YYYY HH:mm"
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("closing_time")
          .setDescription(
            "Paris time: DD/MM/YYYY HH:mm"
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("image_url")
          .setDescription(
            "HTTPS image URL for the top-right corner"
          )
          .setRequired(false)
          .setMaxLength(500)
      )
      .addStringOption(option =>
        option
          .setName("myparis_url")
          .setDescription(
            "Lien du Predictor MyParis de ce match, facultatif"
          )
          .setMaxLength(512)
      )
      .addChannelOption(option =>
        option
          .setName("channel")
          .setDescription(
            "Predictions channel"
          )
          .addChannelTypes(
            ChannelType.GuildText
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("match-result")
      .setDescription(
        "Saisir le score officiel et attribuer les points"
      )
      .addStringOption(option =>
        option
          .setName("match_id")
          .setDescription(
            "ID reçu dans le salon de stats"
          )
          .setRequired(true)
          .setMaxLength(20)
      )
      .addStringOption(option =>
        option
          .setName("score")
          .setDescription(
            "Score domicile-extérieur, ex. 2-1"
          )
          .setRequired(true)
          .setMaxLength(10)
      ),

    new SlashCommandBuilder()
      .setName("classement")
      .setDescription(
        "Publier ou actualiser le top 10"
      ),

    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription(
        "Publish or refresh the shared top 10 leaderboard"
      ),

    new SlashCommandBuilder()
      .setName("reset-classement")
      .setDescription(
        "Réinitialiser le classement général"
      ),

    new SlashCommandBuilder()
      .setName("reset-leaderboard")
      .setDescription(
        "Reset the overall leaderboard"
      ),

    new SlashCommandBuilder()
      .setName("mes-pronos")
      .setDescription(
        "Voir tes pronostics validés"
      ),

    new SlashCommandBuilder()
      .setName("match-cancel")
      .setDescription(
        "Annuler un match créé par erreur"
      )
      .addStringOption(option =>
        option
          .setName("match_id")
          .setDescription(
            "ID du match"
          )
          .setRequired(true)
          .setMaxLength(20)
      ),

    new SlashCommandBuilder()
      .setName("match-list")
      .setDescription(
        "Retrouver les matchs et leurs identifiants"
      ),

    new SlashCommandBuilder()
      .setName("export-pronos")
      .setDescription(
        "Exporter la sauvegarde et le classement complet"
      ),

    new SlashCommandBuilder()
      .setName("diagnostic")
      .setDescription(
        "Vérifier le volume et les données sauvegardées"
      ),
  ].map(command => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({
    version: "10",
  }).setToken(
    process.env.DISCORD_TOKEN
  );

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands() }
  );

  console.log(
    "Commandes Discord synchronisées."
  );
}

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      if (
        interaction.guildId !==
        process.env.DISCORD_GUILD_ID
      ) {
        return;
      }

      if (storageFailed) {
        throw new Error(
          "Sauvegarde indisponible. Le staff doit vérifier le volume et redémarrer le bot."
        );
      }

      if (
        interaction.isChatInputCommand()
      ) {
        if (
          [
            "match-list",
            "export-pronos",
            "diagnostic",
          ].includes(
            interaction.commandName
          )
        ) {
          return await staffTools(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "match-setup"
        ) {
          return await setupMatch(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "match-setup-en"
        ) {
          return await setupMatch(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "match-result"
        ) {
          return await beginResult(
            interaction
          );
        }

        if (
          [
            "classement",
            "leaderboard",
          ].includes(
            interaction.commandName
          )
        ) {
          return await updateLeaderboard(
            interaction
          );
        }

        if (
          [
            "reset-classement",
            "reset-leaderboard",
          ].includes(
            interaction.commandName
          )
        ) {
          return await requestLeaderboardReset(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "match-cancel"
        ) {
          return await cancelMatch(
            interaction
          );
        }

        if (
          interaction.commandName ===
          "mes-pronos"
        ) {
          const lines = [];

          for (
            const [matchId, picks]
            of predictions
          ) {
            const pick = picks.get(
              interaction.user.id
            );

            const match = matches.get(
              matchId
            );

            if (!pick || !match) {
              continue;
            }

            lines.push(
              `**${match.homeTeam} vs ${match.awayTeam}**\n` +
              `${outcomeLabel(pick.outcome)} · ${pick.scoreHome}-${pick.scoreAway}\n` +
              `⚽ ${displayPlayers(pick.scorers, match.language, match.squad)} · 👟 ${displayPlayers(pick.assisters, match.language, match.squad)}\n` +
              (
                match.status === "settled"
                  ? `🏆 ${pick.points} pts`
                  : "🔒 Validé"
              )
            );
          }

          return await interaction.reply({
            content:
              lines.join("\n\n").slice(0, 1900) ||
              "Tu n’as pas encore validé de pronostic.",
            ephemeral: true,
          });
        }
      }

      if (interaction.isButton()) {
        const [
          ,
          action,
          ...parts
        ] = interaction.customId.split(":");

        const value = parts.join(":");

        if (
          action === "players-page" ||
          action === "players-next"
        ) {
          return await playerButtons(
            interaction,
            action,
            parts
          );
        }

        if (action === "open") {
          return await openPrediction(
            interaction,
            value
          );
        }

        if (action === "view") {
          return await viewPrediction(
            interaction,
            value
          );
        }

        if (action === "score-open") {
          return await interaction.showModal(
            scoreModal(value)
          );
        }

        if (action === "confirm") {
          return await savePrediction(
            interaction,
            value
          );
        }

        if (action === "rank") {
          return await showMyRank(
            interaction
          );
        }

        if (
          action === "result-confirm"
        ) {
          return await finishResult(
            interaction,
            value
          );
        }

        if (
          action === "result-cancel"
        ) {
          requireAdmin(interaction);

          resultSessions.delete(
            sessionKey(
              value,
              interaction.user.id
            )
          );

          return await interaction.update({
            content:
              "Saisie du résultat annulée.",
            components: [],
          });
        }

        if (
          action === "reset-confirm"
        ) {
          return await applyLeaderboardReset(
            interaction
          );
        }

        if (
          action === "reset-cancel"
        ) {
          return await interaction.update({
            content:
              "Réinitialisation annulée.",
            components: [],
          });
        }
      }

      if (
        interaction.isStringSelectMenu()
      ) {
        const [
          ,
          type,
          matchId,
          rawPage = "0",
        ] = interaction.customId.split(":");

        if (
          [
            "scorers",
            "assisters",
            "result-scorers",
            "result-assisters",
          ].includes(type)
        ) {
          const staff =
            type.startsWith("result-");

          if (staff) {
            requireAdmin(interaction);
          }

          const match = matches.get(
            matchId
          );

          const session = staff
            ? resultSessions.get(
                sessionKey(
                  matchId,
                  interaction.user.id
                )
              )
            : getSession(
                interaction,
                matchId
              );

          if (
            !match ||
            !session ||
            session.expiresAt < Date.now()
          ) {
            throw new Error(
              "Cette étape a expiré. Relance la saisie."
            );
          }

          if (!staff) {
            requireOpen(
              match,
              interaction.user.id
            );
          }

          const field = type.replace(
            "result-",
            ""
          );

          const page = Number(rawPage);

          if (
            !Number.isInteger(page) ||
            page < 0 ||
            page >= Math.ceil(
              match.squad.length / 24
            )
          ) {
            throw new Error(
              "Page invalide."
            );
          }

          const next =
            mergePlayerSelection(
              match,
              session[field],
              interaction.values,
              page,
              staff
            );

          session[field] = next;

          return await interaction.update(
            playerPayload(
              match,
              field,
              session,
              staff,
              page
            )
          );
        }

        return await handleSelect(
          interaction,
          type,
          matchId
        );
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          "psg:score:"
        )
      ) {
        return await scoreSubmitted(
          interaction,
          interaction.customId.slice(
            "psg:score:".length
          )
        );
      }
    } catch (error) {
      console.error(
        "Opération :",
        error.message
      );

      const response = {
        content:
          error.message ||
          "Une erreur est survenue. Réessaie.",
        ephemeral: true,
      };

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction
          .followUp(response)
          .catch(() => {});
      } else {
        await interaction
          .reply(response)
          .catch(() => {});
      }
    }
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    try {
      console.log(
        `Connecté : ${readyClient.user.tag} | Données : ${dataFile}`
      );

      await registerCommands();

      for (
        const match
        of matches.values()
      ) {
        match.dirty = true;
      }

      persist();
      await tick();

      timer = setInterval(
        () => void tick().catch(
          error =>
            console.error(
              "Programmation :",
              error.message
            )
        ),
        15000
      );
    } catch (error) {
      console.error(
        "Initialisation :",
        error.message
      );

      client.destroy();
      process.exitCode = 1;
    }
  }
);

client.on(
  Events.Error,
  error =>
    console.error(
      "Discord :",
      error.message
    )
);

async function start() {
  for (
    const key of [
      "DISCORD_TOKEN",
      "DISCORD_CLIENT_ID",
      "DISCORD_GUILD_ID",
    ]
  ) {
    if (!process.env[key]) {
      throw new Error(
        `${key} manquant.`
      );
    }
  }

  myParisURL();
  initStorage();

  for (
    const signal
    of ["SIGINT", "SIGTERM"]
  ) {
    process.once(signal, () => {
      clearInterval(timer);
      client.destroy();
      process.exit(0);
    });
  }

  await client.login(
    process.env.DISCORD_TOKEN
  );
}

if (require.main === module) {
  start().catch(error => {
    console.error(
      "Démarrage :",
      error.message
    );

    process.exitCode = 1;
  });
} else {
  module.exports = {
    categoryPoints,
    PSG_SQUAD,
    POINTS,
    parseParisDate,
    formatDate,
    initStorage,
    persist,
    snapshot,
    hydrate,
    mergePlayerSelection,
    playerPayload,
    matchEmbed,
    matchButtons,
    validPlayers,
    validPick,
    leaderboardRows,
    finishResult,
    savePrediction,
    commands,
    client,
    tick,
    handleSelect,
    scoreSubmitted,
    startPredictionPayload,
    playerButtons,
    beginResult,
    applyLeaderboardReset,
  };
}
