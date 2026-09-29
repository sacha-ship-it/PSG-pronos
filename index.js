const crypto = require("node:crypto");
const {
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
const { DateTime } = require("luxon");

const PSG_EMOJI = "<:psg:1389999731941310526>";
const PARIS_TZ = "Europe/Paris";
const MAX_PLAYER_PICKS = 3;
const POINTS = { outcome: 2, exactScore: 5, scorer: 3, assist: 3 };

// Effectif masculin PSG 2026-2027.
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
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Les données sont en mémoire et disparaissent au redémarrage du bot.
const matches = new Map();
const predictions = new Map();
const sessions = new Map();
const resultSessions = new Map();

let leaderboardMessage = null;
let leaderboardLanguage = "fr";
let leaderboardResetAt = 0;

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN manquant.");
if (!process.env.DISCORD_CLIENT_ID) throw new Error("DISCORD_CLIENT_ID manquant.");
if (!process.env.DISCORD_GUILD_ID) throw new Error("DISCORD_GUILD_ID manquant.");

function isAdmin(interaction) {
  return interaction.memberPermissions?.has("ManageGuild") ?? false;
}

function parseParisDate(value) {
  const parsed = DateTime.fromFormat(value.trim(), "dd/MM/yyyy HH:mm", {
    zone: PARIS_TZ,
    setZone: true,
    locale: "fr",
  });

  if (!parsed.isValid) {
    throw new Error(`Date invalide : ${value}. Format attendu : JJ/MM/AAAA HH:mm (heure de Paris).`);
  }

  return parsed;
}

function parseScore(value) {
  const match = value.trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
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

  return (language === "en" ? english : french)[outcome];
}

function getActualOutcome(homeGoals, awayGoals, homeTeam, awayTeam) {
  const isPsg = (team) => /psg|paris saint[- ]germain|paris sg/i.test(team);
  const homeIsPsg = isPsg(homeTeam);
  const awayIsPsg = isPsg(awayTeam);

  if (homeIsPsg === awayIsPsg) {
    throw new Error('Ajoute « PSG » ou « Paris Saint-Germain » au nom de l’équipe du PSG.');
  }

  const psgGoals = homeIsPsg ? homeGoals : awayGoals;
  const otherGoals = homeIsPsg ? awayGoals : homeGoals;

  return psgGoals > otherGoals ? "win" : psgGoals < otherGoals ? "loss" : "draw";
}

function squadMenuOptions() {
  return [
    ...PSG_SQUAD.map((player, index) => ({
      label: `#${player.number} ${player.name}`,
      value: String(index),
    })),
    { label: "Aucun buteur / passeur du PSG", value: "none" },
  ];
}

function playerMenu(matchId, type) {
  const language = matches.get(matchId)?.language || "fr";
  const label =
    type === "scorers"
      ? tr(language, "Choisis jusqu’à 3 buteurs du PSG", "Select up to 3 PSG scorers")
      : tr(language, "Choisis jusqu’à 3 passeurs du PSG", "Select up to 3 PSG assists");

  return new StringSelectMenuBuilder()
    .setCustomId(`psg:${type}:${matchId}`)
    .setPlaceholder(label)
    .setMinValues(1)
    .setMaxValues(MAX_PLAYER_PICKS)
    .addOptions(squadMenuOptions());
}

function menuRow(menu) {
  return new ActionRowBuilder().addComponents(menu);
}

function matchEmbed(match) {
  const kickoff = DateTime.fromMillis(match.kickoffAt, { zone: PARIS_TZ });
  const closes = DateTime.fromMillis(match.closesAt, { zone: PARIS_TZ });
  const english = match.language === "en";

  const intro = english
    ? `${PSG_EMOJI} **Your turn!**\nMake your prediction and climb the overall leaderboard.\n\n`
    : `${PSG_EMOJI} **À toi de jouer !**\nFais ton pronostic et grimpe au classement général.\n\n`;

  const schedule = english
    ? `Kick-off: **${kickoff.toFormat("cccc d LLLL · HH:mm", { locale: "en" })}**\nPredictions close: **${closes.toFormat("cccc d LLLL · HH:mm", { locale: "en" })}**\n\nThe top players will be rewarded.`
    : `Coup d’envoi : **${kickoff.toFormat("cccc d LLLL · HH:mm", { locale: "fr" })}**\nClôture des pronostics : **${closes.toFormat("cccc d LLLL · HH:mm", { locale: "fr" })}**\n\nLes meilleurs seront récompensés.`;

  const embed = new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(`${match.homeTeam} vs ${match.awayTeam}`)
    .setDescription(intro + schedule)
    .addFields({
      name: english ? "Scoring" : "Barème",
      value: english
        ? `Correct result: **+${POINTS.outcome} pts**\nExact score: **+${POINTS.exactScore} pts**\nPSG scorer(s): **+${POINTS.scorer} pts**\nPSG assist(s): **+${POINTS.assist} pts**`
        : `Bon résultat : **+${POINTS.outcome} pts**\nScore exact : **+${POINTS.exactScore} pts**\nButeur(s) du PSG : **+${POINTS.scorer} pts**\nPasseur(s) du PSG : **+${POINTS.assist} pts**`,
    })
    .setFooter({ text: english ? "PSG Match Predictions" : "Pronostics PSG" });

  if (match.imageUrl) embed.setThumbnail(match.imageUrl);
  return embed;
}

function matchButtons(matchId, language) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`psg:open:${matchId}`)
      .setLabel(tr(language, "Faire mon pronostic", "Make my prediction"))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`psg:view:${matchId}`)
      .setLabel(tr(language, "Voir mon pronostic", "View my prediction"))
      .setStyle(ButtonStyle.Secondary),
  );
}

async function logStaff(message) {
  if (!process.env.STATS_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(process.env.STATS_CHANNEL_ID);
    if (channel?.isTextBased()) await channel.send({ content: message });
  } catch (error) {
    console.error("Erreur dans le salon de stats :", error.message);
  }
}

async function setupMatch(interaction) {
  const language = interaction.commandName === "match-setup-en" ? "en" : "fr";
  const english = language === "en";

  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const homeTeam = interaction.options.getString(english ? "home_team" : "equipe_domicile").trim();
    const awayTeam = interaction.options.getString(english ? "away_team" : "equipe_exterieure").trim();
    const kickoff = parseParisDate(interaction.options.getString(english ? "kick_off" : "coup_denvoi"));
    const closes = parseParisDate(interaction.options.getString(english ? "closing_time" : "cloture"));

    if (homeTeam.toLocaleLowerCase("fr") === awayTeam.toLocaleLowerCase("fr")) {
      throw new Error("Les équipes doivent être différentes.");
    }
    if (closes <= DateTime.now().setZone(PARIS_TZ)) {
      throw new Error("La clôture doit être dans le futur.");
    }
    if (closes > kickoff) {
      throw new Error("La clôture doit être avant le coup d’envoi.");
    }

    const channelId =
      interaction.options.getChannel(english ? "channel" : "salon")?.id ||
      process.env.PREDICTIONS_CHANNEL_ID;

    if (!channelId) {
      throw new Error("Choisis le salon dans la commande ou configure PREDICTIONS_CHANNEL_ID.");
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error("Le salon sélectionné n’est pas un salon texte.");
    }

    const imageUrl = interaction.options.getString("image_url");
    if (imageUrl) {
      let image;
      try {
        image = new URL(imageUrl);
      } catch {
        throw new Error("URL d’image invalide.");
      }
      if (image.protocol !== "https:") {
        throw new Error("L’URL de l’image doit commencer par https://.");
      }
    }

    const id = `PSG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const match = {
      id,
      homeTeam,
      awayTeam,
      language,
      imageUrl,
      kickoffAt: kickoff.toMillis(),
      closesAt: closes.toMillis(),
      channelId,
      messageId: null,
      status: "open",
      resultHome: null,
      resultAway: null,
      actualScorers: [],
      actualAssisters: [],
    };

    matches.set(id, match);
    predictions.set(id, new Map());

    const message = await channel.send({
      embeds: [matchEmbed(match)],
      components: [matchButtons(id, language)],
    });

    match.messageId = message.id;

    await logStaff(
      `🆕 Match prêt · ID \`${id}\` · **${homeTeam} vs ${awayTeam}** · Clôture ${closes.toFormat("dd/MM/yyyy HH:mm")} (Paris) · <#${channelId}>`,
    );

    return interaction.editReply(
      `✅ Pronostics lancés dans <#${channelId}>. ID staff pour /match-result : \`${id}\``,
    );
  } catch (error) {
    return interaction.editReply(error.message || "Impossible de créer le match.");
  }
}

function sessionKey(matchId, userId) {
  return `${matchId}:${userId}`;
}

function getSession(interaction, matchId) {
  const session = sessions.get(sessionKey(matchId, interaction.user.id));
  if (!session) {
    throw new Error("Cette étape a expiré. Clique à nouveau sur « Faire mon pronostic ».");
  }
  return session;
}

function startPredictionPayload(match, userId) {
  sessions.set(sessionKey(match.id, userId), {
    outcome: null,
    scoreHome: null,
    scoreAway: null,
    scorers: null,
    assisters: null,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:outcome:${match.id}`)
    .addOptions(
      { label: tr(match.language, "Victoire du PSG", "PSG win"), value: "win" },
      { label: tr(match.language, "Match nul", "Draw"), value: "draw" },
      { label: tr(match.language, "Défaite du PSG", "PSG lose"), value: "loss" },
    );

  menu.setPlaceholder(tr(match.language, "Quel sera le résultat du PSG ?", "What will the PSG result be?"));

  return {
    content: `**${match.homeTeam} vs ${match.awayTeam}**\n\n**1/4 · ${tr(match.language, "Résultat", "Result")}**\n${tr(match.language, "Qui l’emporte ?", "Who will win?")}`,
    components: [menuRow(menu)],
  };
}

function scoreModal(matchId, language = "fr") {
  return new ModalBuilder()
    .setCustomId(`psg:score:${matchId}`)
    .setTitle(tr(language, "Ton score exact", "Your exact score"))
    .addComponents(
      menuRow(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel(tr(language, "Score domicile-extérieur, ex. 2-1", "Home-away score, e.g. 2-1"))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2-1")
          .setRequired(true)
          .setMaxLength(5),
      ),
    );
}

function displayPlayers(players, language = "fr") {
  if (!players?.length || players.includes("none")) {
    return tr(language, "Aucun", "None");
  }

  return players
    .map((index) => PSG_SQUAD[Number(index)]?.name)
    .filter(Boolean)
    .join(", ");
}

function recapPayload(match, session) {
  const editMenu = new StringSelectMenuBuilder()
    .setCustomId(`psg:edit-field:${match.id}`)
    .setPlaceholder(tr(match.language, "Modifier une réponse avant validation", "Edit an answer before confirming"))
    .addOptions(
      { label: tr(match.language, "Modifier le résultat", "Edit result"), value: "outcome" },
      { label: tr(match.language, "Modifier le score exact", "Edit exact score"), value: "score" },
      { label: tr(match.language, "Modifier les buteurs", "Edit scorers"), value: "scorers" },
      { label: tr(match.language, "Modifier les passeurs", "Edit assists"), value: "assisters" },
    );

  return {
    content:
      `**${PSG_EMOJI} ${tr(match.language, "Récapitulatif", "Summary")} · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `${tr(match.language, "Résultat", "Result")} : **${outcomeLabel(session.outcome, match.language)}**\n` +
      `${tr(match.language, "Score", "Score")} : **${session.scoreHome}-${session.scoreAway}**\n` +
      `${tr(match.language, "Buteur(s) PSG", "PSG scorer(s)")} : **${displayPlayers(session.scorers)}**\n` +
      `${tr(match.language, "Passeur(s) PSG", "PSG assists")} : **${displayPlayers(session.assisters)}**\n\n` +
      tr(
        match.language,
        "Modifie une réponse si besoin, puis valide. Après validation, ton prono ne pourra plus être changé.",
        "Edit any answer if needed, then confirm. Once confirmed, your prediction cannot be changed.",
      ),
    components: [
      menuRow(editMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`psg:confirm:${match.id}`)
          .setLabel(tr(match.language, "Valider mon pronostic", "Confirm my prediction"))
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

async function openPrediction(interaction, matchId) {
  const match = matches.get(matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    return interaction.reply({ content: "🔒 Les pronostics sont clôturés.", ephemeral: true });
  }

  const existing = predictions.get(matchId)?.get(interaction.user.id);
  if (existing) {
    return interaction.reply({
      content: "✅ Tu as déjà validé ton pronostic. Il n’est plus modifiable. Utilise **Voir mon pronostic** pour le consulter.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    ...startPredictionPayload(match, interaction.user.id),
    ephemeral: true,
  });
}

function validateMulti(values) {
  if (values.includes("none") && values.length > 1) return false;
  return values.length >= 1 && values.length <= MAX_PLAYER_PICKS;
}

async function handleSelect(interaction, type, matchId) {
  const match = matches.get(matchId);
  const session = getSession(interaction, matchId);

  if (!match) throw new Error("Match introuvable.");

  if (type === "outcome") {
    session.outcome = interaction.values[0];

    if (session.scorers && session.assisters && session.scoreHome !== null) {
      return interaction.update(recapPayload(match, session));
    }

    return interaction.update({
      content: `✅ Résultat choisi : **${outcomeLabel(session.outcome)}**\n\n**2/4 · Score exact**`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:score-open:${matchId}`)
            .setLabel("Saisir le score")
            .setEmoji("🔢")
            .setStyle(ButtonStyle.Primary),
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
          { label: "Victoire du PSG", value: "win", emoji: "🔴" },
          { label: "Match nul", value: "draw", emoji: "🤝" },
          { label: "Défaite du PSG", value: "loss", emoji: "🔵" },
        );

      return interaction.update({
        content: "✏️ Modifie ton résultat :",
        components: [menuRow(menu)],
      });
    }

    if (field === "score") {
      return interaction.showModal(scoreModal(matchId));
    }

    if (field === "scorers" || field === "assisters") {
      const menu = playerMenu(matchId, field);
      return interaction.update({
        content: field === "scorers"
          ? "✏️ Modifie tes buteurs (1 à 3 choix) :"
          : "✏️ Modifie tes passeurs (1 à 3 choix) :",
        components: [menuRow(menu)],
      });
    }
  }

  if (type === "scorers" || type === "assisters") {
    if (!validateMulti(interaction.values)) {
      return interaction.update({
        content: "Choisis « Aucun » seul, ou sélectionne de 1 à 3 joueurs. Réessaie :",
        components: [menuRow(playerMenu(matchId, type))],
      });
    }

    session[type] = interaction.values;

    if (type === "scorers") {
      if (session.assisters) {
        return interaction.update(recapPayload(match, session));
      }

      return interaction.update({
        content: "**4/4 · Passeurs décisifs du PSG**\nChoisis de 1 à 3 joueurs, ou « Aucun ».",
        components: [menuRow(playerMenu(matchId, "assisters"))],
      });
    }

    return interaction.update(recapPayload(match, session));
  }
}

async function scoreSubmitted(interaction, matchId) {
  const session = getSession(interaction, matchId);
  const score = parseScore(interaction.fields.getTextInputValue("score"));

  if (!score) {
    return interaction.reply({
      content: "Format incorrect. Entre le score comme `2-1`.",
      ephemeral: true,
    });
  }

  [session.scoreHome, session.scoreAway] = score;
  const match = matches.get(matchId);

  if (session.scorers && session.assisters) {
    return interaction.update(recapPayload(match, session));
  }

  return interaction.update({
    content: "**3/4 · Buteurs du PSG**\nChoisis de 1 à 3 joueurs, ou « Aucun ».",
    components: [menuRow(playerMenu(matchId, "scorers"))],
  });
}

async function savePrediction(interaction, matchId) {
  const match = matches.get(matchId);
  const session = getSession(interaction, matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    sessions.delete(sessionKey(matchId, interaction.user.id));
    return interaction.update({
      content: "🔒 La clôture est passée. Ton prono n’a pas été enregistré.",
      components: [],
    });
  }

  if (predictions.get(matchId)?.has(interaction.user.id)) {
    sessions.delete(sessionKey(matchId, interaction.user.id));
    return interaction.update({
      content: "Tu as déjà validé un prono pour ce match. Il ne peut plus être modifié.",
      components: [],
    });
  }

  predictions.get(matchId).set(interaction.user.id, {
    userId: interaction.user.id,
    outcome: session.outcome,
    scoreHome: session.scoreHome,
    scoreAway: session.scoreAway,
    scorers: session.scorers,
    assisters: session.assisters,
    points: 0,
  });

  sessions.delete(sessionKey(matchId, interaction.user.id));

  await interaction.update({
    content: `✅ **Pronostic validé !** Bonne chance, supporter parisien. ${PSG_EMOJI}`,
    components: [],
  });

  await logStaff(
    `📝 Prono validé · Match \`${matchId}\` · <@${interaction.user.id}> · ${outcomeLabel(session.outcome)} · ${session.scoreHome}-${session.scoreAway} · Buteurs : ${displayPlayers(session.scorers)} · Passeurs : ${displayPlayers(session.assisters)}`,
  );
}

async function viewPrediction(interaction, matchId) {
  const match = matches.get(matchId);
  const pick = predictions.get(matchId)?.get(interaction.user.id);

  if (!match || !pick) {
    return interaction.reply({
      content: "Tu n’as pas encore validé de pronostic pour ce match.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    content:
      `**${PSG_EMOJI} Ton pronostic · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `🎯 Résultat : **${outcomeLabel(pick.outcome)}**\n🔢 Score : **${pick.scoreHome}-${pick.scoreAway}**\n` +
      `⚽ Buteur(s) : **${displayPlayers(pick.scorers)}**\n🅰️ Passeur(s) : **${displayPlayers(pick.assisters)}**\n\n` +
      (match.status === "settled"
        ? `🏆 Points gagnés : **${pick.points} pts**`
        : "🔒 Prono validé et verrouillé."),
    ephemeral: true,
  });
}

function leaderboardRows() {
  const table = new Map();

  for (const [matchId, matchPicks] of predictions) {
    const match = matches.get(matchId);

    if (!match || match.status !== "settled" || (match.settledAt || 0) <= leaderboardResetAt) {
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
    (a, b) => b.points - a.points || b.matches - a.matches || a.userId.localeCompare(b.userId),
  );
}

function leaderboardEmbed(language = "fr") {
  const rows = leaderboardRows();
  const description = rows.length
    ? rows
        .slice(0, 10)
        .map((row, index) => `**${index + 1}.** <@${row.userId}> — **${row.points} pts**`)
        .join("\n")
    : tr(
        language,
        "Le classement apparaîtra après le premier match réglé.",
        "The leaderboard will appear after the first match is settled.",
      );

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(tr(language, "CLASSEMENT GÉNÉRAL", "OVERALL LEADERBOARD"))
    .setDescription(
      `${description}\n\n${tr(language, "Les meilleurs seront récompensés.", "The top players will be rewarded.")}`,
    )
    .setFooter({
      text: tr(language, "Top 10 · Clique pour voir ta position", "Top 10 · Click to see your rank"),
    })
    .setTimestamp();
}

async function updateLeaderboard(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!process.env.LEADERBOARD_CHANNEL_ID) {
    return interaction.editReply("Ajoute LEADERBOARD_CHANNEL_ID dans Railway.");
  }

  const channel = await client.channels.fetch(process.env.LEADERBOARD_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    return interaction.editReply("LEADERBOARD_CHANNEL_ID ne correspond pas à un salon texte.");
  }

  const language = interaction.commandName === "leaderboard" ? "en" : "fr";
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("psg:rank:me")
        .setLabel(tr(language, "Voir ma position", "See my rank"))
        .setStyle(ButtonStyle.Primary),
    ),
  ];

  try {
    if (leaderboardMessage?.channelId === channel.id) {
      const oldMessage = await channel.messages.fetch(leaderboardMessage.id).catch(() => null);

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
        leaderboardMessage = { channelId: channel.id, id: sent.id };
      }
    } else {
      const sent = await channel.send({
        embeds: [leaderboardEmbed(language)],
        components,
      });
      leaderboardMessage = { channelId: channel.id, id: sent.id };
    }

    leaderboardLanguage = language;

    return interaction.editReply(
      tr(language, "Classement général publié / actualisé.", "Overall leaderboard published / refreshed."),
    );
  } catch (error) {
    console.error(error);
    return interaction.editReply("Je n’ai pas pu publier le classement. Vérifie mes permissions dans ce salon.");
  }
}

async function showMyRank(interaction) {
  const rows = leaderboardRows();
  const index = rows.findIndex((row) => row.userId === interaction.user.id);

  if (index < 0) {
    return interaction.reply({
      content: "Tu n’as pas encore de points au classement. Tes points apparaîtront après un match terminé.",
      ephemeral: true,
    });
  }

  const row = rows[index];
  const tenth = rows[9];
  const gap = index >= 10 && tenth ? Math.max(0, tenth.points - row.points) : 0;

  const positionText =
    index < 10
      ? `Tu es **${index + 1}${index === 0 ? "er" : "e"}** avec **${row.points} points**. Tu es dans le top 10 ! 🔥`
      : `Tu es **${index + 1}e** avec **${row.points} points**. Il te manque **${gap} point(s)** pour rejoindre le top 10. 💪`;

  return interaction.reply({
    content: `📍 **Ta position au classement général**\n${positionText}`,
    ephemeral: true,
  });
}

async function requestLeaderboardReset(interaction) {
  return interaction.reply({
    content:
      "Cette action remet à zéro les points du classement actuel. Les pronostics et résultats des matchs restent en mémoire. Confirmer ?",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("psg:reset-confirm")
          .setLabel("Confirmer la réinitialisation")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("psg:reset-cancel")
          .setLabel("Annuler")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    ephemeral: true,
  });
}

async function applyLeaderboardReset(interaction) {
  leaderboardResetAt = Date.now();

  if (leaderboardMessage) {
    const channel = await client.channels.fetch(leaderboardMessage.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(leaderboardMessage.id).catch(() => null)
      : null;

    if (message) {
      await message.edit({ embeds: [leaderboardEmbed(leaderboardLanguage)] }).catch(() => {});
    }
  }

  return interaction.update({
    content: "Classement réinitialisé. Les prochains résultats commenceront un nouveau classement.",
    components: [],
  });
}

function resultMenu(matchId, field) {
  const match = matches.get(matchId);
  const language = match?.language || "fr";

  return new StringSelectMenuBuilder()
    .setCustomId(`psg:result-${field}:${matchId}`)
    .setPlaceholder(
      tr(
        language,
        field === "scorers" ? "Sélectionne les buteurs du PSG" : "Sélectionne les passeurs du PSG",
        field === "scorers" ? "Select PSG scorers" : "Select PSG assists",
      ),
    )
    .setMinValues(1)
    .setMaxValues(25)
    .addOptions(squadMenuOptions());
}

async function beginResult(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const match = matches.get(matchId);

  if (!match || match.status === "cancelled") {
    return interaction.reply({ content: "Match introuvable ou annulé.", ephemeral: true });
  }

  if (match.status === "settled" && (match.settledAt || 0) <= leaderboardResetAt) {
    return interaction.reply({
      content: "Ce match appartient à un classement déjà réinitialisé et ne peut plus être modifié.",
      ephemeral: true,
    });
  }

  const score = parseScore(interaction.options.getString("score"));
  if (!score) {
    return interaction.reply({
      content: "Format de score attendu : 2-1 (domicile-extérieur).",
      ephemeral: true,
    });
  }

  const [homeGoals, awayGoals] = score;

  try {
    getActualOutcome(homeGoals, awayGoals, match.homeTeam, match.awayTeam);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }

  resultSessions.set(sessionKey(matchId, interaction.user.id), {
    homeGoals,
    awayGoals,
    scorers: null,
    assisters: null,
  });

  return interaction.reply({
    content: tr(
      match.language,
      "Sélectionne les buteurs PSG du match. Tu peux en choisir autant qu’il y en a.",
      "Select the PSG scorers. Choose every player who scored.",
    ),
    components: [menuRow(resultMenu(matchId, "scorers"))],
    ephemeral: true,
  });
}

async function finishResult(interaction, matchId) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  const match = matches.get(matchId);
  const key = sessionKey(matchId, interaction.user.id);
  const result = resultSessions.get(key);

  if (!match || !result) {
    return interaction.reply({
      content: "Cette saisie de résultat a expiré. Relance /match-result.",
      ephemeral: true,
    });
  }

  if (match.status === "settled" && (match.settledAt || 0) <= leaderboardResetAt) {
    return interaction.update({
      content: "Ce match appartient à un classement déjà réinitialisé.",
      components: [],
    });
  }

  const actualScorers = result.scorers.includes("none") ? [] : result.scorers;
  const actualAssisters = result.assisters.includes("none") ? [] : result.assisters;
  const actualOutcome = getActualOutcome(
    result.homeGoals,
    result.awayGoals,
    match.homeTeam,
    match.awayTeam,
  );
  const picks = predictions.get(matchId) || new Map();

  for (const pick of picks.values()) {
    let points = pick.outcome === actualOutcome ? POINTS.outcome : 0;

    if (pick.scoreHome === result.homeGoals && pick.scoreAway === result.awayGoals) {
      points += POINTS.exactScore;
    }

    const scorerCorrect = pick.scorers.includes("none")
      ? actualScorers.length === 0
      : pick.scorers.some((value) => actualScorers.includes(value));

    const assistCorrect = pick.assisters.includes("none")
      ? actualAssisters.length === 0
      : pick.assisters.some((value) => actualAssisters.includes(value));

    if (scorerCorrect) points += POINTS.scorer;
    if (assistCorrect) points += POINTS.assist;

    pick.points = points;
  }

  match.status = "settled";
  match.resultHome = result.homeGoals;
  match.resultAway = result.awayGoals;
  match.actualScorers = actualScorers;
  match.actualAssisters = actualAssisters;
  match.settledAt = Date.now();

  resultSessions.delete(key);

  const scorerNames = displayPlayers(actualScorers, match.language);
  const assisterNames = displayPlayers(actualAssisters, match.language);

  await logStaff(
    `Résultat enregistré · ID \`${matchId}\` · ${match.homeTeam} ${result.homeGoals}-${result.awayGoals} ${match.awayTeam} · Buteurs : ${scorerNames} · Passeurs : ${assisterNames}`,
  );

  return interaction.update({
    content: tr(
      match.language,
      `Résultat enregistré : **${result.homeGoals}-${result.awayGoals}**. Les pronostics sont notés. Lance /classement pour publier la mise à jour.`,
      `Result saved: **${result.homeGoals}-${result.awayGoals}**. Predictions are scored. Run /leaderboard to publish the update.`,
    ),
    components: [],
  });
}

async function cancelMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const match = matches.get(matchId);

  if (!match || !["open", "closed"].includes(match.status)) {
    return interaction.reply({ content: "Match introuvable ou déjà réglé.", ephemeral: true });
  }

  match.status = "cancelled";

  const channel = await client.channels.fetch(match.channelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(match.messageId).catch(() => null)
    : null;

  if (message) {
    const cancelled = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("psg:cancelled")
        .setLabel("Match annulé")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );

    await message
      .edit({
        embeds: [EmbedBuilder.from(message.embeds[0]).setFooter({ text: "Match annulé" })],
        components: [cancelled],
      })
      .catch(() => {});
  }

  await logStaff(`🚫 Match annulé · ID \`${matchId}\` · ${match.homeTeam} vs ${match.awayTeam}`);

  return interaction.reply({
    content: `Match \`${matchId}\` annulé.`,
    ephemeral: true,
  });
}

async function closeExpiredMatches() {
  for (const match of matches.values()) {
    if (match.status !== "open" || Date.now() < match.closesAt) continue;

    match.status = "closed";

    const channel = await client.channels.fetch(match.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(match.messageId).catch(() => null)
      : null;

    if (message) {
      const closed = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("psg:closed")
          .setLabel(tr(match.language, "Pronostics clôturés", "Predictions closed"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`psg:view:${match.id}`)
          .setLabel(tr(match.language, "Voir mon pronostic", "View my prediction"))
          .setStyle(ButtonStyle.Secondary),
      );

      await message
        .edit({
          embeds: [
            EmbedBuilder.from(message.embeds[0]).setFooter({
              text: tr(match.language, "Pronostics clôturés", "Predictions closed"),
            }),
          ],
          components: [closed],
        })
        .catch((error) => console.error("Fermeture du message impossible :", error.message));
    }

    await logStaff(`🔒 Pronostics clôturés · ID \`${match.id}\` · ${match.homeTeam} vs ${match.awayTeam}`);
  }
}

function commands() {
  return [
    new SlashCommandBuilder()
      .setName("match-setup")
      .setDescription("Créer le post pronostics d’un match")
      .addStringOption((o) =>
        o.setName("equipe_domicile").setDescription("Ex. PSG").setRequired(true).setMaxLength(80),
      )
      .addStringOption((o) =>
        o.setName("equipe_exterieure").setDescription("Ex. Lyon").setRequired(true).setMaxLength(80),
      )
      .addStringOption((o) =>
        o.setName("coup_denvoi").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("cloture").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("image_url")
          .setDescription("URL HTTPS de l’image affichée en haut à droite")
          .setRequired(false)
          .setMaxLength(500),
      )
      .addChannelOption((o) =>
        o
          .setName("salon")
          .setDescription("Salon des pronostics")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("match-setup-en")
      .setDescription("Create a match prediction post in English")
      .addStringOption((o) =>
        o.setName("home_team").setDescription("Home team, e.g. PSG").setRequired(true).setMaxLength(80),
      )
      .addStringOption((o) =>
        o.setName("away_team").setDescription("Away team, e.g. Lyon").setRequired(true).setMaxLength(80),
      )
      .addStringOption((o) =>
        o.setName("kick_off").setDescription("Paris time: DD/MM/YYYY HH:mm").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("closing_time").setDescription("Paris time: DD/MM/YYYY HH:mm").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("image_url")
          .setDescription("HTTPS image URL for the top-right corner")
          .setRequired(false)
          .setMaxLength(500),
      )
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Predictions channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("match-result")
      .setDescription("Saisir le score officiel et attribuer les points")
      .addStringOption((o) =>
        o
          .setName("match_id")
          .setDescription("ID reçu dans le salon de stats")
          .setRequired(true)
          .setMaxLength(20),
      )
      .addStringOption((o) =>
        o
          .setName("score")
          .setDescription("Score domicile-extérieur, ex. 2-1")
          .setRequired(true)
          .setMaxLength(10),
      ),
    new SlashCommandBuilder()
      .setName("classement")
      .setDescription("Publier ou actualiser le top 10"),
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Publish or refresh the shared top 10 leaderboard"),
    new SlashCommandBuilder()
      .setName("reset-classement")
      .setDescription("Réinitialiser le classement général"),
    new SlashCommandBuilder()
      .setName("reset-leaderboard")
      .setDescription("Reset the overall leaderboard"),
    new SlashCommandBuilder()
      .setName("mes-pronos")
      .setDescription("Voir tes pronostics validés"),
    new SlashCommandBuilder()
      .setName("match-cancel")
      .setDescription("Annuler un match créé par erreur")
      .addStringOption((o) =>
        o.setName("match_id").setDescription("ID du match").setRequired(true).setMaxLength(20),
      ),
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands() },
  );

  console.log("Commandes Discord synchronisées.");
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "match-setup") return setupMatch(interaction);
      if (interaction.commandName === "match-setup-en") return setupMatch(interaction);
      if (interaction.commandName === "match-result") return beginResult(interaction);
      if (["classement", "leaderboard"].includes(interaction.commandName)) {
        return updateLeaderboard(interaction);
      }
      if (["reset-classement", "reset-leaderboard"].includes(interaction.commandName)) {
        return requestLeaderboardReset(interaction);
      }
      if (interaction.commandName === "match-cancel") return cancelMatch(interaction);

      if (interaction.commandName === "mes-pronos") {
        const lines = [];

        for (const [matchId, picks] of predictions) {
          const pick = picks.get(interaction.user.id);
          const match = matches.get(matchId);
          if (!pick || !match) continue;

          lines.push(
            `**${match.homeTeam} vs ${match.awayTeam}**\n${outcomeLabel(pick.outcome)} · ${pick.scoreHome}-${pick.scoreAway}\n⚽ ${displayPlayers(pick.scorers)} · 🅰️ ${displayPlayers(pick.assisters)}\n${match.status === "settled" ? `🏆 ${pick.points} pts` : "🔒 Validé"}`,
          );
        }

        return interaction.reply({
          content: lines.join("\n\n").slice(0, 1900) || "Tu n’as pas encore validé de pronostic.",
          ephemeral: true,
        });
      }
    }

    if (interaction.isButton()) {
      const [, action, ...parts] = interaction.customId.split(":");
      const value = parts.join(":");

      if (action === "open") return openPrediction(interaction, value);
      if (action === "view") return viewPrediction(interaction, value);
      if (action === "score-open") return interaction.showModal(scoreModal(value));
      if (action === "confirm") return savePrediction(interaction, value);
      if (action === "rank") return showMyRank(interaction);
      if (action === "result-confirm") return finishResult(interaction, value);

      if (action === "result-cancel") {
        resultSessions.delete(sessionKey(value, interaction.user.id));
        return interaction.update({
          content: "Saisie du résultat annulée.",
          components: [],
        });
      }

      if (action === "reset-confirm") return applyLeaderboardReset(interaction);

      if (action === "reset-cancel") {
        return interaction.update({
          content: "Réinitialisation annulée.",
          components: [],
        });
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [, type, ...parts] = interaction.customId.split(":");
      const matchId = parts.join(":");

      if (type === "result-scorers" || type === "result-assisters") {
        const session = resultSessions.get(sessionKey(matchId, interaction.user.id));
        const match = matches.get(matchId);

        if (!session || !match) {
          throw new Error("Cette saisie de résultat a expiré. Relance /match-result.");
        }

        if (interaction.values.includes("none") && interaction.values.length > 1) {
          return interaction.update({
            content: "Choisis « Aucun » seul, ou sélectionne tous les joueurs concernés.",
            components: [
              menuRow(resultMenu(matchId, type === "result-scorers" ? "scorers" : "assisters")),
            ],
          });
        }

        if (type === "result-scorers") {
          session.scorers = interaction.values;

          return interaction.update({
            content: tr(
              match.language,
              "Sélectionne tous les passeurs du PSG.",
              "Select every PSG player who assisted a goal.",
            ),
            components: [menuRow(resultMenu(matchId, "assisters"))],
          });
        }

        session.assisters = interaction.values;

        return interaction.update({
          content: tr(
            match.language,
            `Résultat à confirmer\nScore : ${session.homeGoals}-${session.awayGoals}\nButeurs PSG : ${displayPlayers(session.scorers, match.language)}\nPasseurs PSG : ${displayPlayers(session.assisters, match.language)}`,
            `Confirm result\nScore: ${session.homeGoals}-${session.awayGoals}\nPSG scorers: ${displayPlayers(session.scorers, match.language)}\nPSG assists: ${displayPlayers(session.assisters, match.language)}`,
          ),
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`psg:result-confirm:${matchId}`)
                .setLabel(tr(match.language, "Confirmer le résultat", "Confirm result"))
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`psg:result-cancel:${matchId}`)
                .setLabel(tr(match.language, "Annuler", "Cancel"))
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }

      return handleSelect(interaction, type, matchId);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("psg:score:")) {
      return scoreSubmitted(interaction, interaction.customId.slice("psg:score:".length));
    }
  } catch (error) {
    console.error(error);

    const response = {
      content: error.message || "Une erreur est survenue. Réessaie.",
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Connecté en tant que ${readyClient.user.tag}`);

  await registerCommands();
  await closeExpiredMatches().catch(console.error);
  setInterval(() => closeExpiredMatches().catch(console.error), 15_000);
});

client.on(Events.Error, (error) => console.error("Erreur Discord :", error));

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Connexion Discord impossible :", error);
  process.exit(1);
});
