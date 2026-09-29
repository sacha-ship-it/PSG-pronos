require("dotenv").config();

const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  ChannelType,
  time,
} = require("discord.js");
const { DateTime } = require("luxon");

const POINTS = {
  outcome: 2,
  score: 5,
  scorer: 3,
  assist: 3,
};

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN manquant.");
if (!process.env.DISCORD_CLIENT_ID) throw new Error("DISCORD_CLIENT_ID manquant.");
if (!process.env.DISCORD_GUILD_ID) throw new Error("DISCORD_GUILD_ID manquant.");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Tout est conservé en mémoire : un redémarrage du bot réinitialise ces données.
const matches = new Map();
const predictions = new Map();
const sessions = new Map();

function parseParisDate(value) {
  const parsed = DateTime.fromFormat(value.trim(), "dd/MM/yyyy HH:mm", {
    zone: "Europe/Paris",
    setZone: true,
    locale: "fr",
  });

  if (!parsed.isValid) {
    throw new Error(`Date invalide : "${value}". Format attendu : JJ/MM/AAAA HH:mm, heure de Paris.`);
  }

  return parsed;
}

function parseScore(value) {
  const match = value.trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function splitNames(value) {
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error("Indique au moins un nom.");
  if (names.some((name) => name.length > 80)) {
    throw new Error("Chaque nom doit faire 80 caractères maximum.");
  }
  return names;
}

function addNoChoice(names) {
  const hasNone = names.some((name) =>
    ["aucun", "aucune", "none", "—", "-"].includes(name.toLocaleLowerCase("fr"))
  );
  return hasNone ? names : [...names, "Aucun"];
}

function cleanName(value) {
  return value.trim().toLocaleLowerCase("fr");
}

function parseActualNames(value) {
  const names = splitNames(value);
  if (names.length === 1 && ["aucun", "aucune", "none", "—", "-"].includes(cleanName(names[0]))) {
    return [];
  }
  return names;
}

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has("ManageGuild")) return true;

  const allowedRoles = (process.env.ADMIN_ROLE_IDS || "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);

  return allowedRoles.some((role) => interaction.member?.roles?.cache?.has(role));
}

function outcomeLabel(outcome) {
  return {
    win: "Victoire du PSG",
    draw: "Match nul",
    loss: "Défaite du PSG",
  }[outcome];
}

function actualOutcome(homeGoals, awayGoals, homeTeam, awayTeam) {
  const isPsg = (team) =>
    /psg|paris saint[- ]germain|paris sg/i.test(team);

  const homeIsPsg = isPsg(homeTeam);
  const awayIsPsg = isPsg(awayTeam);

  if (homeIsPsg === awayIsPsg) {
    throw new Error('Impossible d’identifier le PSG. Mets « PSG » ou « Paris Saint-Germain » dans le nom de son équipe.');
  }

  const psgGoals = homeIsPsg ? homeGoals : awayGoals;
  const opponentGoals = homeIsPsg ? awayGoals : homeGoals;

  if (psgGoals > opponentGoals) return "win";
  if (psgGoals < opponentGoals) return "loss";
  return "draw";
}

function namesOptions(names) {
  return names.slice(0, 25).map((name, index) => ({
    label: name.slice(0, 100),
    value: String(index),
  }));
}

function matchEmbed(match) {
  const embed = new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(`${match.homeTeam} - ${match.awayTeam}`)
    .setDescription(
      [
        `Pronostics ouverts jusqu’au ${time(Math.floor(match.closesAt / 1000), "F")} (heure de Paris).`,
        `Coup d’envoi : ${time(Math.floor(match.kickoffAt / 1000), "F")}`,
        "",
        "Prédisez le résultat, le score exact, un buteur du PSG et un passeur décisif du PSG.",
        "Les pronostics restent privés jusqu’à la clôture.",
      ].join("\n")
    )
    .addFields(
      { name: "ID du match", value: `\`${match.id}\``, inline: true },
      {
        name: "Barème",
        value: `Résultat **+${POINTS.outcome}** · Score exact **+${POINTS.score}** · Buteur **+${POINTS.scorer}** · Passeur **+${POINTS.assist}**`,
      }
    );

  if (match.imageUrl) embed.setImage(match.imageUrl);
  return embed;
}

function makeWizardPayload(match, userId) {
  sessions.set(`${match.id}:${userId}`, {
    matchId: match.id,
    userId,
    outcome: null,
    scoreHome: null,
    scoreAway: null,
    scorer: null,
    assister: null,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:outcome:${match.id}`)
    .setPlaceholder("Choisis le résultat du PSG")
    .addOptions(
      { label: "Victoire du PSG", value: "win", emoji: "🔴" },
      { label: "Match nul", value: "draw", emoji: "🤝" },
      { label: "Défaite du PSG", value: "loss", emoji: "🔵" }
    );

  return {
    content: `**${match.homeTeam} - ${match.awayTeam}**\nÉtape 1/4 · Quel résultat prédis-tu ?`,
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

function getSession(interaction, matchId) {
  const session = sessions.get(`${matchId}:${interaction.user.id}`);
  if (!session) throw new Error("La session a expiré. Clique de nouveau sur « Faire mon pronostic ».");
  return session;
}

function scoreModal(matchId) {
  return new ModalBuilder()
    .setCustomId(`psg:score:${matchId}`)
    .setTitle("Score exact")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel("Score domicile-extérieur, par exemple 2-1")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2-1")
          .setRequired(true)
          .setMaxLength(5)
      )
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
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const homeTeam = interaction.options.getString("equipe_domicile").trim();
    const awayTeam = interaction.options.getString("equipe_exterieure").trim();
    const kickoff = parseParisDate(interaction.options.getString("coup_denvoi"));
    const closes = parseParisDate(interaction.options.getString("cloture"));

    if (homeTeam.toLocaleLowerCase("fr") === awayTeam.toLocaleLowerCase("fr")) {
      throw new Error("Les deux équipes doivent être différentes.");
    }
    if (closes <= DateTime.now().setZone("Europe/Paris")) {
      throw new Error("La clôture doit être dans le futur.");
    }
    if (closes > kickoff) throw new Error("La clôture doit être avant le coup d’envoi.");

    const scorers = addNoChoice(splitNames(interaction.options.getString("buteurs_psg")));
    const assisters = addNoChoice(splitNames(interaction.options.getString("passeurs_psg")));

    if (scorers.length > 25 || assisters.length > 25) {
      throw new Error("Maximum 24 noms par liste. Le choix « Aucun » est ajouté automatiquement.");
    }

    const imageUrl = interaction.options.getString("image_url");
    if (imageUrl && !/^https:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(imageUrl)) {
      throw new Error("L’image doit être une URL HTTPS terminant par .png, .jpg, .jpeg, .gif ou .webp.");
    }

    const channelId = interaction.options.getChannel("salon")?.id || process.env.PREDICTIONS_CHANNEL_ID;
    if (!channelId) throw new Error("Indique un salon ou configure PREDICTIONS_CHANNEL_ID.");

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("Le salon choisi n’est pas un salon texte.");

    const id = `PSG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const match = {
      id,
      homeTeam,
      awayTeam,
      kickoffAt: kickoff.toMillis(),
      closesAt: closes.toMillis(),
      imageUrl,
      scorers,
      assisters,
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
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:open:${id}`)
            .setLabel("Faire mon pronostic")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });

    match.messageId = message.id;

    await logStaff(
      `🆕 Match créé · ID \`${id}\` · **${homeTeam} - ${awayTeam}** · Clôture ${closes.toFormat("dd/MM/yyyy HH:mm")} (heure de Paris) · <#${channelId}>`
    );

    return interaction.editReply(`Match créé. ID : \`${id}\` · Message publié dans <#${channelId}>.`);
  } catch (error) {
    return interaction.editReply(error.message || "Impossible de créer le match.");
  }
}

async function openPrediction(interaction, matchId) {
  const match = matches.get(matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    return interaction.reply({ content: "Les pronostics pour ce match sont clôturés ou indisponibles.", ephemeral: true });
  }

  return interaction.reply({
    ...makeWizardPayload(match, interaction.user.id),
    ephemeral: true,
  });
}

async function handleSelect(interaction, step, matchId) {
  const session = getSession(interaction, matchId);
  const match = matches.get(matchId);

  if (step === "outcome") {
    session.outcome = interaction.values[0];

    return interaction.update({
      content: `Résultat : **${outcomeLabel(session.outcome)}**.\nÉtape 2/4 · Saisis le score exact.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:score-open:${matchId}`)
            .setLabel("Saisir le score")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });
  }

  if (step === "scorer" || step === "assister") {
    const list = step === "scorer" ? match.scorers : match.assisters;
    const selected = list[Number(interaction.values[0])];
    if (!selected) throw new Error("Choix invalide. Recommence le pronostic.");

    if (step === "scorer") {
      session.scorer = selected;

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`psg:assister:${matchId}`)
        .setPlaceholder("Choisis le passeur décisif du PSG")
        .addOptions(namesOptions(match.assisters));

      return interaction.update({
        content: "Étape 4/4 · Choisis le passeur décisif du PSG.",
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    session.assister = selected;

    return interaction.update({
      content: [
        `**Récapitulatif · ${match.homeTeam} - ${match.awayTeam}**`,
        `Résultat : **${outcomeLabel(session.outcome)}**`,
        `Score : **${session.scoreHome}-${session.scoreAway}**`,
        `Buteur PSG : **${session.scorer}**`,
        `Passeur PSG : **${session.assister}**`,
        "",
        "Confirme pour enregistrer. Tu pourras modifier ton prono avant la clôture.",
      ].join("\n"),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:confirm:${matchId}`)
            .setLabel("Confirmer mon prono")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`psg:edit:${matchId}`)
            .setLabel("Modifier mon prono")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }
}

async function savePrediction(interaction, matchId) {
  const session = getSession(interaction, matchId);
  const match = matches.get(matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    sessions.delete(`${matchId}:${interaction.user.id}`);
    return interaction.update({ content: "La clôture est passée. Ton prono n’a pas été enregistré.", components: [] });
  }

  if (!predictions.has(matchId)) predictions.set(matchId, new Map());

  predictions.get(matchId).set(interaction.user.id, {
    userId: interaction.user.id,
    outcome: session.outcome,
    scoreHome: session.scoreHome,
    scoreAway: session.scoreAway,
    scorer: session.scorer,
    assister: session.assister,
    points: 0,
  });

  sessions.delete(`${matchId}:${interaction.user.id}`);

  await interaction.update({
    content: `✅ Ton pronostic pour **${match.homeTeam} - ${match.awayTeam}** est enregistré. Tu peux le modifier depuis le bouton du match avant la clôture.`,
    components: [],
  });

  await logStaff(
    `📝 Prono enregistré · Match \`${matchId}\` · <@${interaction.user.id}> · ${outcomeLabel(session.outcome)} · ${session.scoreHome}-${session.scoreAway} · Buteur : ${session.scorer} · Passeur : ${session.assister}`
  );
}

async function scoreSubmitted(interaction, matchId) {
  const session = getSession(interaction, matchId);
  const match = matches.get(matchId);
  const score = parseScore(interaction.fields.getTextInputValue("score"));

  if (!score) {
    return interaction.reply({ content: "Format invalide. Écris le score comme `2-1`.", ephemeral: true });
  }

  [session.scoreHome, session.scoreAway] = score;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:scorer:${matchId}`)
    .setPlaceholder("Choisis un buteur du PSG")
    .addOptions(namesOptions(match.scorers));

  return interaction.update({
    content: "Étape 3/4 · Choisis un buteur du PSG.",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

function getLeaderboardRows() {
  const totals = new Map();

  for (const [matchId, matchPicks] of predictions.entries()) {
    const match = matches.get(matchId);
    if (!match || match.status !== "settled") continue;

    for (const pick of matchPicks.values()) {
      const current = totals.get(pick.userId) || { points: 0, matches: 0 };
      current.points += pick.points;
      current.matches += 1;
      totals.set(pick.userId, current);
    }
  }

  return [...totals.entries()]
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.points - a.points || b.matches - a.matches)
    .slice(0, 25);
}

function leaderboardEmbed(limit = 25) {
  const rows = getLeaderboardRows().slice(0, limit);
  const description = rows.length
    ? rows.map((row, index) => `**${index + 1}.** <@${row.userId}> · **${row.points} pts** (${row.matches} matchs)`).join("\n")
    : "Aucun résultat comptabilisé pour le moment.";

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle("Classement général · Pronostics PSG")
    .setDescription(description)
    .setTimestamp();
}

async function postLeaderboard() {
  if (!process.env.STATS_CHANNEL_ID) return;
  const channel = await client.channels.fetch(process.env.STATS_CHANNEL_ID).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ embeds: [leaderboardEmbed(15)] });
}

async function settleMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const match = matches.get(matchId);

  if (!match) return interaction.editReply(`Match \`${matchId}\` introuvable.`);
  if (match.status === "settled") return interaction.editReply(`Le match \`${matchId}\` a déjà été réglé.`);

  const score = parseScore(interaction.options.getString("score"));
  if (!score) return interaction.editReply("Score invalide. Exemple : `2-1`, dans l’ordre domicile-extérieur.");

  try {
    const [homeGoals, awayGoals] = score;
    const result = actualOutcome(homeGoals, awayGoals, match.homeTeam, match.awayTeam);
    const actualScorers = parseActualNames(interaction.options.getString("buteurs_psg"));
    const actualAssisters = parseActualNames(interaction.options.getString("passeurs_psg"));
    const matchPicks = predictions.get(matchId) || new Map();

    for (const pick of matchPicks.values()) {
      let points = 0;

      if (pick.outcome === result) points += POINTS.outcome;
      if (pick.scoreHome === homeGoals && pick.scoreAway === awayGoals) points += POINTS.score;

      const scorerCorrect = actualScorers.some((name) => cleanName(name) === cleanName(pick.scorer));
      const assisterCorrect = actualAssisters.some((name) => cleanName(name) === cleanName(pick.assister));

      if (scorerCorrect) points += POINTS.scorer;
      if (assisterCorrect) points += POINTS.assist;

      pick.points = points;
    }

    match.status = "settled";
    match.resultHome = homeGoals;
    match.resultAway = awayGoals;
    match.actualScorers = actualScorers;
    match.actualAssisters = actualAssisters;

    await interaction.editReply(
      `Résultat enregistré pour \`${matchId}\` : **${homeGoals}-${awayGoals}**. Points calculés pour ${matchPicks.size} prono(s).`
    );

    await logStaff(
      `🏁 Match réglé · ID \`${matchId}\` · **${match.homeTeam} ${homeGoals}-${awayGoals} ${match.awayTeam}** · Buteurs PSG : ${actualScorers.join(", ") || "aucun"} · Passeurs PSG : ${actualAssisters.join(", ") || "aucun"} · ${matchPicks.size} prono(s) calculés`
    );

    await postLeaderboard();
  } catch (error) {
    console.error(error);
    return interaction.editReply(error.message || "Erreur pendant le calcul des points.");
  }
}

function leaderboardCommand() {
  return interaction.reply({
    embeds: [leaderboardEmbed()],
    ephemeral: false,
  });
}

function slashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("match-setup")
      .setDescription("Créer un match et ouvrir les pronostics")
      .addStringOption((option) => option.setName("equipe_domicile").setDescription("Équipe affichée en premier").setRequired(true).setMaxLength(80))
      .addStringOption((option) => option.setName("equipe_exterieure").setDescription("Équipe affichée en second").setRequired(true).setMaxLength(80))
      .addStringOption((option) => option.setName("coup_denvoi").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true))
      .addStringOption((option) => option.setName("cloture").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true))
      .addStringOption((option) => option.setName("buteurs_psg").setDescription("Noms séparés par des virgules").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("passeurs_psg").setDescription("Noms séparés par des virgules").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("image_url").setDescription("URL HTTPS d’image (facultatif)").setRequired(false).setMaxLength(500))
      .addChannelOption((option) => option.setName("salon").setDescription("Salon des pronostics").addChannelTypes(ChannelType.GuildText).setRequired(false)),

    new SlashCommandBuilder()
      .setName("match-result")
      .setDescription("Saisir le résultat et attribuer les points")
      .addStringOption((option) => option.setName("match_id").setDescription("ID du match indiqué dans le salon de stats").setRequired(true).setMaxLength(20))
      .addStringOption((option) => option.setName("score").setDescription("Score domicile-extérieur, ex. 2-1").setRequired(true).setMaxLength(10))
      .addStringOption((option) => option.setName("buteurs_psg").setDescription("Buteurs PSG réels, séparés par des virgules, ou aucun").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("passeurs_psg").setDescription("Passeurs PSG réels, séparés par des virgules, ou aucun").setRequired(true).setMaxLength(1000)),

    new SlashCommandBuilder()
      .setName("classement")
      .setDescription("Afficher le classement général"),

    new SlashCommandBuilder()
      .setName("mes-pronos")
      .setDescription("Voir tes pronostics"),

    new SlashCommandBuilder()
      .setName("match-cancel")
      .setDescription("Annuler un match créé par erreur")
      .addStringOption((option) => option.setName("match_id").setDescription("ID du match").setRequired(true).setMaxLength(20)),
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: slashCommands() }
  );

  console.log("Commandes Discord synchronisées.");
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
      await message.edit({
        embeds: [EmbedBuilder.from(message.embeds[0]).setColor(0x777777).setFooter({ text: "Pronostics clôturés" })],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("psg:closed")
              .setLabel("Pronostics clôturés")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          ),
        ],
      }).catch((error) => console.error("Erreur de fermeture du message :", error.message));
    }

    await logStaff(`🔒 Pronostics clôturés automatiquement · Match \`${match.id}\` · ${match.homeTeam} - ${match.awayTeam}`);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "match-setup") return setupMatch(interaction);
      if (interaction.commandName === "match-result") return settleMatch(interaction);

      if (interaction.commandName === "classement") {
        return interaction.reply({
          embeds: [leaderboardEmbed()],
          ephemeral: false,
        });
      }

      if (interaction.commandName === "mes-pronos") {
        const userPicks = [];

        for (const [matchId, matchPicks] of predictions.entries()) {
          const pick = matchPicks.get(interaction.user.id);
          const match = matches.get(matchId);
          if (pick && match) {
            userPicks.push(
              `**${match.homeTeam} - ${match.awayTeam}** · \`${matchId}\`\n` +
              `${outcomeLabel(pick.outcome)} · ${pick.scoreHome}-${pick.scoreAway} · Buteur : ${pick.scorer} · Passeur : ${pick.assister}\n` +
              `${match.status === "settled" ? `**${pick.points} pts**` : "Points en attente"}`
            );
          }
        }

        return interaction.reply({
          content: userPicks.join("\n\n").slice(0, 1900) || "Tu n’as encore aucun pronostic.",
          ephemeral: true,
        });
      }

      if (interaction.commandName === "match-cancel") {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
        }

        const matchId = interaction.options.getString("match_id").trim().toUpperCase();
        const match = matches.get(matchId);
        if (!match || !["open", "closed"].includes(match.status)) {
          return interaction.reply({ content: `Match \`${matchId}\` introuvable ou déjà réglé.`, ephemeral: true });
        }

        match.status = "cancelled";
        const channel = await client.channels.fetch(match.channelId).catch(() => null);
        const message = channel?.isTextBased()
          ? await channel.messages.fetch(match.messageId).catch(() => null)
          : null;

        if (message) {
          await message.edit({
            embeds: [EmbedBuilder.from(message.embeds[0]).setColor(0x777777).setFooter({ text: "Match annulé" })],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("psg:cancelled").setLabel("Match annulé").setStyle(ButtonStyle.Secondary).setDisabled(true)
              ),
            ],
          }).catch(() => {});
        }

        await logStaff(`🚫 Match annulé · ID \`${matchId}\` · ${match.homeTeam} - ${match.awayTeam}`);
        return interaction.reply({ content: `Match \`${matchId}\` annulé.`, ephemeral: true });
      }
    }

    if (interaction.isButton()) {
      const [, action, ...parts] = interaction.customId.split(":");
      const matchId = parts.join(":");

      if (action === "open") return openPrediction(interaction, matchId);
      if (action === "score-open") return interaction.showModal(scoreModal(matchId));
      if (action === "confirm") return savePrediction(interaction, matchId);

      if (action === "edit") {
        const match = matches.get(matchId);
        if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
          return interaction.update({ content: "Les pronostics sont clôturés.", components: [] });
        }
        return interaction.update(makeWizardPayload(match, interaction.user.id));
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [, step, ...parts] = interaction.customId.split(":");
      return handleSelect(interaction, step, parts.join(":"));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("psg:score:")) {
      return scoreSubmitted(interaction, interaction.customId.slice("psg:score:".length));
    }
  } catch (error) {
    console.error(error);
    const response = { content: error.message || "Une erreur est survenue. Réessaie.", ephemeral: true };

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
  console.error("Impossible de connecter le bot :", error);
  process.exit(1);
});
