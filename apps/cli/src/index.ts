#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Argument, Command } from "commander";
import {
  contentLimits,
  synthesisOutputSchema,
  type AgentRole,
  type Execution,
  type ExecutionMode,
  type ExecutionTestRun,
  type Message,
  type ProjectMode,
  type ProjectWorkflowSnapshot,
  type Session,
} from "@open-day/domain";
import {
  analyzeEvaluationScores,
  configsFromManifest,
  createBlindPacket,
  evaluationConditions,
  EvaluationRunner,
  parseEvaluationManifest,
  providersRequiredByManifest,
  parseScoreSheet,
  scoreCriteria,
  type BlindEvaluationKey,
  type EvaluationManifest,
  type EvaluationReport,
} from "@open-day/evaluation";
import {
  CandidateTestService,
  ControlPlaneStore,
  DeliberationService,
  ExecutionService,
  ProjectWorkflowService,
  type ContributionNotice,
  type ExecutionProgressNotice,
} from "@open-day/control-plane";
import {
  AnthropicRuntimeAdapter,
  FakeRuntimeAdapter,
  GoogleRuntimeAdapter,
  loadAnthropicConfigFromEnv,
  loadGoogleConfigFromEnv,
  loadOpenAIConfigFromEnv,
  OpenAIRuntimeAdapter,
  RuntimeRouterAdapter,
} from "@open-day/runtime";

const program = new Command();

program
  .name("open-day")
  .description("Délibération et exécution multi-agents locales, contrôlées par l'utilisateur")
  .version("0.3.0")
  .option(
    "--database <path>",
    "chemin de la base SQLite",
    process.env.OPEN_DAY_DATABASE ?? resolve(process.cwd(), ".open-day", "open-day.db"),
  )
  .option(
    "--actor <id>",
    "identifiant public de l'utilisateur inscrit dans le journal",
    process.env.OPEN_DAY_ACTOR ?? "local-user",
  )
  .addHelpText(
    "after",
    "\nParcours recommandé : open-day project start --help\nLes commandes sans préfixe project exposent les primitives avancées et le banc d'évaluation.\n",
  );

const projectCommand = program
  .command("project")
  .description("Parcours guidé : choisir un mode puis avancer automatiquement entre les validations")
  .showHelpAfterError();

projectCommand
  .command("start")
  .description("Créer un projet guidé et avancer par défaut jusqu'à la première validation")
  .argument("<goal>", "objectif ou problème à traiter")
  .option("--mode <mode>", "design, coordinated ou competitive", "design")
  .option("--workspace <path>", "dépôt Git; dossier courant pour un mode d'exécution")
  .option("--budget <usd>", "budget de conception", "0.20")
  .option("--execution-budget <usd>", "budget de l'exécution", "1.00")
  .option("--max-corrections <count>", "nombre maximal de corrections humaines", "2")
  .option("--provider <provider>", "fournisseur par défaut", "mock")
  .option("--model <model>", "modèle du fournisseur par défaut")
  .option("--architect <provider:model>", "modèle affecté à l'architecte")
  .option("--critic <provider:model>", "modèle affecté au critique")
  .option("--security <provider:model>", "modèle affecté à la sécurité")
  .option("--no-run", "créer uniquement; ne pas lancer le brainstorming")
  .action(async (goal: string, options: {
    mode: string;
    workspace?: string;
    budget: string;
    executionBudget: string;
    maxCorrections: string;
    provider: string;
    model?: string;
    architect?: string;
    critic?: string;
    security?: string;
    run: boolean;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project }) => {
        const mode = parseProjectMode(options.mode);
        const provider = parseProvider(options.provider);
        const model = resolveModel(provider, options.model);
        const fallback = { provider, model };
        const agentAssignments = {
          architect: parseAgentSelection(options.architect, fallback),
          critic: parseAgentSelection(options.critic, fallback),
          security: parseAgentSelection(options.security, fallback),
        } satisfies Record<AgentRole, { provider: Provider; model: string }>;
        for (const assignment of Object.values(agentAssignments)) {
          requireProviderConfiguration(assignment.provider);
        }
        let snapshot = project.start({
          goal,
          mode,
          designBudgetLimitMicrousd: parseUsd(options.budget),
          maxCycles: 1,
          agentProvider: provider,
          agentModel: model,
          agentAssignments,
          actorId: currentActorId(),
          ...(mode === "DESIGN"
            ? {}
            : {
                workspacePath: resolve(options.workspace ?? process.cwd()),
                executionBudgetLimitMicrousd: parseUsd(options.executionBudget),
                maxCorrectionRounds: parseNonNegativeInteger(
                  options.maxCorrections,
                  "max-corrections",
                  10,
                ),
              }),
        });
        console.log(`Projet guidé créé : ${snapshot.project.id}`);
        if (options.run) {
          snapshot = await project.next(snapshot.project.id, {
            signal,
            onDesignContribution: printContribution,
            onExecutionProgress: printExecutionProgress,
          });
        }
        printProjectSnapshot(project.store, snapshot);
      });
    });
  });

projectCommand
  .command("next")
  .description("Exécuter automatiquement les étapes sûres jusqu'à la prochaine validation")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .action(async (projectId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project }) => {
        const snapshot = await project.next(projectId, {
          signal,
          onDesignContribution: printContribution,
          onExecutionProgress: printExecutionProgress,
        });
        printProjectSnapshot(project.store, snapshot);
      });
    });
  });

projectCommand
  .command("approve")
  .description("Approuver exactement la décision humaine actuellement attendue")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .option("--candidate <id>", "remplacer la présélection du coordinateur")
  .option(
    "--accept-open-questions",
    "accepter explicitement les questions bloquantes lors de l'alignement",
    false,
  )
  .option("--continue", "avancer ensuite automatiquement jusqu'à la porte suivante", false)
  .action(async (projectId: string | undefined, options: {
    candidate?: string;
    acceptOpenQuestions: boolean;
    continue: boolean;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project }) => {
        let snapshot = await project.approveCurrentGate(projectId, {
          actorId: currentActorId(),
          signal,
          acceptOpenQuestions: options.acceptOpenQuestions,
          ...(options.candidate ? { candidateId: options.candidate } : {}),
        });
        if (options.continue) {
          snapshot = await project.next(snapshot.project.id, {
            signal,
            onDesignContribution: printContribution,
            onExecutionProgress: printExecutionProgress,
          });
        }
        printProjectSnapshot(project.store, snapshot);
      });
    });
  });

projectCommand
  .command("apply")
  .description("Appliquer le candidat déjà approuvé; aucun commit ou push n'est créé")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .action(async (projectId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project }) => {
        const snapshot = await project.apply(projectId, signal);
        printProjectSnapshot(project.store, snapshot);
      });
    });
  });

projectCommand
  .command("cancel")
  .description("Annuler durablement le workflow sans appliquer de candidat")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .action((projectId?: string) => {
    withService(({ project }) => {
      const snapshot = project.cancel(projectId, currentActorId());
      console.log("Projet annulé; aucun commit ou push n'a été créé.");
      printProjectSnapshot(project.store, snapshot);
    });
  });

projectCommand
  .command("revise")
  .description("Demander une correction bornée d'un candidat puis la faire réévaluer")
  .argument("<instructions>", "correction publique demandée")
  .option("--project <id>", "identifiant; le projet guidé le plus récent par défaut")
  .option("--candidate <id>", "candidat à corriger; présélection actuelle par défaut")
  .option("--no-run", "enregistrer seulement la demande sans lancer la correction")
  .action(async (instructions: string, options: {
    project?: string;
    candidate?: string;
    run: boolean;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project }) => {
        let snapshot = project.requestCorrection(
          options.project,
          instructions,
          options.candidate,
          currentActorId(),
        );
        if (options.run) {
          snapshot = await project.next(snapshot.project.id, {
            signal,
            onExecutionProgress: printExecutionProgress,
          });
        }
        printProjectSnapshot(project.store, snapshot);
      });
    });
  });

projectCommand
  .command("test")
  .description("Tester un candidat dans un worktree jetable avec une commande fournie par l'utilisateur")
  .argument("<command...>", "commande et arguments; utilisez -- avant la commande")
  .option("--project <id>", "identifiant; le projet guidé le plus récent par défaut")
  .option("--candidate <id>", "candidat; présélection du coordinateur par défaut")
  .option("--timeout <seconds>", "délai maximal entre 1 et 900 secondes", "300")
  .action(async (command: string[], options: {
    project?: string;
    candidate?: string;
    timeout: string;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ project, candidateTest }) => {
        const snapshot = project.snapshot(options.project);
        if (!snapshot.execution) {
          throw new Error("Ce projet n'a pas encore produit de candidat exécutable.");
        }
        printCandidateTestSafetyNotice(command);
        const run = await candidateTest.run({
          executionId: snapshot.execution.id,
          ...(options.candidate ? { candidateId: options.candidate } : {}),
          command,
          timeoutMs: parseTestTimeout(options.timeout),
          actorId: currentActorId(),
          signal,
        });
        printExecutionTestRun(run);
        printProjectSnapshot(project.store, project.snapshot(snapshot.project.id));
        if (run.status !== "PASSED") process.exitCode = 1;
      });
    });
  });

projectCommand
  .command("tests")
  .description("Afficher les commandes de test et leurs résultats enregistrés")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .action((projectId?: string) => {
    withService(({ project, store }) => {
      const snapshot = project.snapshot(projectId);
      if (!snapshot.execution) {
        console.log("Aucun test : le projet n'a pas encore d'exécution de code.");
        return;
      }
      printExecutionTests(store, snapshot.execution.id);
    });
  });

projectCommand
  .command("status")
  .description("Afficher la phase, la validation attendue et la prochaine commande")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .action((projectId?: string) => {
    withService(({ project }) => {
      printProjectSnapshot(project.store, project.snapshot(projectId));
    });
  });

projectCommand
  .command("doctor")
  .description("Diagnostiquer ou récupérer prudemment une exécution interrompue")
  .argument("[project]", "identifiant; le projet guidé le plus récent par défaut")
  .option("--repair", "récupérer le verrou et compter les réservations comme coût incertain", false)
  .option("--force", "récupérer malgré un processus possiblement actif", false)
  .action(async (projectId: string | undefined, options: { repair: boolean; force: boolean }) => {
    await withServiceAsync(async ({ project, store, execution, candidateTest }) => {
      const snapshot = project.snapshot(projectId);
      if (!snapshot.execution) {
        console.log("Aucune exécution de code n'est encore liée à ce projet.");
        printProjectSnapshot(store, snapshot);
        return;
      }
      await diagnoseExecution(
        store,
        execution,
        candidateTest,
        snapshot.execution.id,
        options,
      );
      printProjectSnapshot(store, project.snapshot(snapshot.project.id));
    });
  });

projectCommand
  .command("ask")
  .description("Intervenir auprès d'un agent pendant une phase de débat")
  .addArgument(
    new Argument("<agent>", "rôle ciblé").choices(["architect", "critic", "security"]),
  )
  .argument("<message>", "question ou contrainte publique")
  .option("--project <id>", "identifiant; le projet guidé le plus récent par défaut")
  .action((agent: AgentRole, message: string, options: { project?: string }) => {
    withService(({ project }) => {
      const stored = project.ask(options.project, agent, message);
      console.log(`Intervention enregistrée : ${stored.id}`);
    });
  });

program
  .command("init")
  .description("Initialiser le stockage local")
  .action(() => {
    withService(({ store }) => {
      console.log(`Stockage initialisé : ${store.filename}`);
    });
  });

program
  .command("start")
  .description("Créer une session de brainstorming")
  .argument("<goal>", "objectif ou problème à traiter")
  .option("--budget <usd>", "budget maximal en dollars", "0.10")
  .option("--max-cycles <count>", "nombre maximal de cycles", "1")
  .option("--provider <provider>", "fournisseur : mock, openai, anthropic ou google", "mock")
  .option("--model <model>", "modèle du fournisseur")
  .option("--architect <provider:model>", "runtime affecté au rôle architecte")
  .option("--critic <provider:model>", "runtime affecté au rôle critique")
  .option("--security <provider:model>", "runtime affecté au rôle sécurité")
  .action((goal: string, options: {
    budget: string;
    maxCycles: string;
    provider: string;
    model?: string;
    architect?: string;
    critic?: string;
    security?: string;
  }) => {
    withService(({ store }) => {
      const provider = parseProvider(options.provider);
      const model = resolveModel(provider, options.model);
      const maxCycles = parsePositiveInteger(options.maxCycles, "max-cycles");
      if (maxCycles !== 1) {
        throw new Error("Open-Day 0.3 exécute exactement un cycle de délibération.");
      }
      const fallback = { provider, model };
      const agentAssignments = {
        architect: parseAgentSelection(options.architect, fallback),
        critic: parseAgentSelection(options.critic, fallback),
        security: parseAgentSelection(options.security, fallback),
      } satisfies Record<AgentRole, { provider: Provider; model: string }>;
      for (const assignment of Object.values(agentAssignments)) {
        requireProviderConfiguration(assignment.provider);
      }
      const session = store.createSession({
        goal,
        budgetLimitMicrousd: parseUsd(options.budget),
        maxCycles,
        agentProvider: provider,
        agentModel: model,
        agentAssignments,
        createdBy: currentActorId(),
      });
      console.log(`Session créée : ${session.id}`);
      printStatus(store, session);
    });
  });

program
  .command("providers")
  .description("Afficher l'état de la configuration des fournisseurs sans révéler les secrets")
  .action(() => {
    const openAI = loadOpenAIConfigFromEnv();
    const anthropic = loadAnthropicConfigFromEnv();
    const google = loadGoogleConfigFromEnv();
    console.log("mock   : prêt (aucun réseau)");
    printProviderConfiguration("openai", openAI, process.env.OPEN_DAY_OPENAI_MODEL);
    printProviderConfiguration("anthropic", anthropic, process.env.OPEN_DAY_ANTHROPIC_MODEL);
    printProviderConfiguration("google", google, process.env.OPEN_DAY_GOOGLE_MODEL);
  });

program
  .command("run")
  .description("Exécuter exactement l'étape courante")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action(async (sessionId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ store, service }) => {
        const before = store.getSession(sessionId);
        console.log(`\nExécution de ${before.stage} — session ${before.id}\n`);
        const session = await service.runCurrentStage(before.id, {
          signal,
          onContribution: printContribution,
        });
        printStatus(store, session);
      });
    });
  });

program
  .command("ask")
  .description("Adresser une intervention humaine à un agent")
  .addArgument(
    new Argument("<agent>", "rôle ciblé").choices(["architect", "critic", "security"]),
  )
  .argument("<message>", "instruction ou question")
  .option("--session <id>", "identifiant de session; la plus récente par défaut")
  .action((agent: AgentRole, message: string, options: { session?: string }) => {
    withService(({ service }) => {
      const stored = service.addHumanIntervention(options.session, agent, message);
      console.log(`Intervention enregistrée pour ${agent} : ${stored.id}`);
      console.log("Elle sera intégrée au prochain appel pertinent.");
    });
  });

program
  .command("status")
  .description("Afficher l'état de la session")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ store }) => {
      const session = store.getSession(sessionId);
      printStatus(store, session);
    });
  });

program
  .command("doctor")
  .description("Vérifier SQLite, les verrous d'exécution et les réservations de budget")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .option(
    "--repair",
    "récupérer une exécution interrompue et compter ses réservations comme coût incertain",
    false,
  )
  .option(
    "--force",
    "autoriser la récupération même si le processus propriétaire semble encore actif",
    false,
  )
  .action(
    (
      sessionId: string | undefined,
      options: { repair: boolean; force: boolean },
    ) => {
      withService(({ store }) => {
        let report = store.inspectHealth(sessionId);
        printHealthReport(report);
        if (!options.repair) return;

        if (report.lease && !options.force) {
          const sameHost = report.lease.ownerHost === hostname();
          const alive = sameHost && isProcessAlive(report.lease.ownerPid);
          if (alive) {
            throw new Error(
              `Le processus ${report.lease.ownerPid} semble encore actif. Arrêtez-le ou utilisez --force en connaissance du risque de double appel.`,
            );
          }
          if (!sameHost) {
            throw new Error(
              "Le verrou appartient à un autre hôte. Utilisez --force uniquement après avoir vérifié qu'aucune exécution n'est encore active.",
            );
          }
        }

        const recovery = store.recoverInterruptedRun(report.session.id);
        if (!recovery.recovered) {
          console.log("Aucune réparation nécessaire.");
          return;
        }
        console.log(
          `Récupération effectuée : ${recovery.reservationsMarkedUnknown} réservation(s), ${formatUsd(recovery.conservativeCostMicrousd)} compté(s) avec prudence.`,
        );
        report = store.inspectHealth(report.session.id);
        printHealthReport(report);
      });
    },
  );

program
  .command("events")
  .description("Afficher le journal d'événements append-only de la session")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .option("--json", "émettre du JSON", false)
  .action((sessionId: string | undefined, options: { json: boolean }) => {
    withService(({ store }) => {
      const session = store.getSession(sessionId);
      const events = store.getEvents(session.id);
      if (options.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }
      for (const event of events) {
        console.log(
          `${String(event.sequence).padStart(4)}  ${event.createdAt}  ${event.type}  ${JSON.stringify(event.payload)}`,
        );
      }
    });
  });

program
  .command("pause")
  .description("Mettre une session en pause par décision humaine")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service, store }) => {
      const session = service.pause(sessionId);
      console.log("Session mise en pause.");
      printStatus(store, session);
    });
  });

program
  .command("resume")
  .description("Reprendre une session mise en pause")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service, store }) => {
      const session = service.resume(sessionId);
      console.log("Session reprise.");
      printStatus(store, session);
    });
  });

program
  .command("cancel")
  .description("Annuler définitivement une session par décision humaine")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service, store }) => {
      const session = service.cancel(sessionId);
      console.log("Session annulée.");
      printStatus(store, session);
    });
  });

program
  .command("transcript")
  .description("Afficher les contributions officielles de la session")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ store }) => {
      const session = store.getSession(sessionId);
      const agents = new Map(store.getAgents(session.id).map((agent) => [agent.id, agent.displayName]));
      const messages = store.getMessages(session.id);
      if (!messages.length) {
        console.log("Le transcript est vide.");
        return;
      }
      for (const message of messages) printTranscriptMessage(message, agents);
    });
  });

program
  .command("spec")
  .description("Afficher le cahier des charges courant")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ store }) => {
      const session = store.getSession(sessionId);
      const specification = store.getLatestSpecification(session.id);
      console.log(specification.content);
      console.log(`\nVersion : ${specification.version} (${specification.status})`);
      console.log(`Hash    : ${specification.contentHash}`);
    });
  });

program
  .command("approve-alignment")
  .description("Valider humainement la synthèse et créer un brouillon de spécification")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .option(
    "--accept-open-questions",
    "accepter explicitement les éventuelles questions bloquantes",
    false,
  )
  .action((sessionId: string | undefined, options: { acceptOpenQuestions: boolean }) => {
    withService(({ service }) => {
      const result = service.approveAlignment(sessionId, options.acceptOpenQuestions);
      console.log(`Alignement approuvé. Brouillon v${result.specification.version} créé.`);
      console.log(`Hash : ${result.specification.contentHash}`);
      console.log("Relisez-le avec la commande spec, puis gelez-le explicitement avec freeze-spec.");
    });
  });

program
  .command("freeze-spec")
  .description("Geler explicitement le cahier des charges courant")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service }) => {
      const result = service.freezeSpecification(sessionId);
      console.log(`Cahier des charges v${result.specification.version} gelé.`);
      console.log(`État : ${result.session.state}`);
      console.log(`Hash : ${result.specification.contentHash}`);
      console.log("Démarrez la phase suivante explicitement avec start-architecture.");
    });
  });

program
  .command("revise-spec")
  .description("Créer une nouvelle version humaine du cahier des charges avant son gel")
  .argument("<file>", "fichier Markdown révisé par l'utilisateur")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((file: string, sessionId?: string) => {
    const absolutePath = resolve(file);
    const content = readUtf8FileLimited(
      absolutePath,
      contentLimits.artifactCharacters * 4,
      "cahier des charges",
    );
    withService(({ service }) => {
      const result = service.reviseSpecification(sessionId, content);
      console.log(`Cahier des charges révisé : v${result.specification.version}.`);
      console.log(`Hash : ${result.specification.contentHash}`);
      console.log("Relisez avec spec, puis gelez explicitement avec freeze-spec.");
    });
  });

program
  .command("start-architecture")
  .description("Démarrer humainement le débat d'architecture sur la spécification gelée")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service, store }) => {
      const session = service.startArchitecture(sessionId);
      console.log("Débat d'architecture démarré sur le cahier des charges gelé.");
      printStatus(store, session);
    });
  });

program
  .command("architecture")
  .description("Afficher l'architecture courante")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ store }) => {
      const session = store.getSession(sessionId);
      const architecture = store.getLatestArchitecture(session.id);
      console.log(architecture.content);
      console.log(`\nVersion : ${architecture.version} (${architecture.status})`);
      console.log(`Hash    : ${architecture.contentHash}`);
    });
  });

program
  .command("revise-architecture")
  .description("Créer une nouvelle version humaine de l'architecture avant approbation")
  .argument("<file>", "fichier Markdown révisé par l'utilisateur")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((file: string, sessionId?: string) => {
    const absolutePath = resolve(file);
    const content = readUtf8FileLimited(
      absolutePath,
      contentLimits.artifactCharacters * 4,
      "architecture",
    );
    withService(({ service }) => {
      const result = service.reviseArchitecture(sessionId, content);
      console.log(`Architecture révisée : v${result.architecture.version}.`);
      console.log(`Hash : ${result.architecture.contentHash}`);
      console.log("Relisez avec architecture, puis approuvez explicitement.");
    });
  });

program
  .command("approve-architecture")
  .description("Approuver humainement l'architecture courante et terminer la session")
  .argument("[session]", "identifiant de session; la plus récente par défaut")
  .action((sessionId?: string) => {
    withService(({ service }) => {
      const result = service.approveArchitecture(sessionId);
      console.log(`Architecture v${result.architecture.version} approuvée.`);
      console.log(`État : ${result.session.state}`);
      console.log(`Hash : ${result.architecture.contentHash}`);
    });
  });

program
  .command("exec-start")
  .description("Créer une exécution isolée à partir d'une conception approuvée")
  .argument("[session]", "session COMPLETED; la plus récente par défaut")
  .requiredOption(
    "--mode <mode>",
    "coordinated : chef et lots; competitive : variantes indépendantes",
  )
  .option("--workspace <path>", "dépôt Git à traiter", process.cwd())
  .option("--goal <goal>", "objectif d'exécution plus précis que celui de la session")
  .option("--budget <usd>", "budget maximal propre à l'exécution", "1.00")
  .option("--max-corrections <count>", "nombre maximal de corrections humaines", "2")
  .action(async (sessionId: string | undefined, options: {
    mode: string;
    workspace: string;
    goal?: string;
    budget: string;
    maxCorrections: string;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const created = await execution.startExecution(
          {
            ...(sessionId ? { sessionId } : {}),
            mode: parseExecutionMode(options.mode),
            workspacePath: resolve(options.workspace),
            budgetLimitMicrousd: parseUsd(options.budget),
            maxCorrectionRounds: parseNonNegativeInteger(
              options.maxCorrections,
              "max-corrections",
              10,
            ),
            actorId: currentActorId(),
            ...(options.goal ? { goal: options.goal } : {}),
          },
          signal,
        );
        console.log(`Exécution créée : ${created.id}`);
        printExecutionStatus(execution.store, created);
      });
    });
  });

program
  .command("exec-plan")
  .description("Générer le plan public de l'exécution sans modifier de fichier")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action(async (executionId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const result = await execution.generatePlan(executionId, {
          signal,
          onProgress: printExecutionProgress,
        });
        console.log("\nPlan proposé :\n");
        console.log(JSON.stringify(result.plan, null, 2));
        console.log("\nAucun fichier n'a été modifié. Validez avec exec-approve-plan.");
        printExecutionStatus(execution.store, result);
      });
    });
  });

program
  .command("exec-approve-plan")
  .description("Valider humainement le plan avant toute génération de modifications")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action((executionId?: string) => {
    withService(({ execution }) => {
      const result = execution.approvePlan(executionId, currentActorId());
      console.log("Plan approuvé et journalisé.");
      printExecutionStatus(execution.store, result);
    });
  });

program
  .command("exec-run")
  .description("Produire les candidats dans des worktrees isolés puis les faire arbitrer")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action(async (executionId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const result = await execution.run(executionId, {
          signal,
          onProgress: printExecutionProgress,
        });
        console.log("\nCandidats produits. Le dépôt principal est toujours intact.");
        printExecutionStatus(execution.store, result);
        printExecutionCandidates(execution.store, result.id);
      });
    });
  });

program
  .command("exec-request-correction")
  .description("Demander humainement la correction d'un candidat")
  .argument("<instructions>", "correction publique demandée")
  .option("--execution <id>", "identifiant; la plus récente par défaut")
  .option("--candidate <id>", "candidat à corriger; présélection actuelle par défaut")
  .action((instructions: string, options: { execution?: string; candidate?: string }) => {
    withService(({ execution }) => {
      const result = execution.requestCorrection(
        options.execution,
        options.candidate,
        instructions,
        currentActorId(),
      );
      console.log(`Correction ${result.correctionRound}/${result.maxCorrectionRounds} enregistrée.`);
      printExecutionStatus(execution.store, result);
    });
  });

program
  .command("exec-correct")
  .description("Produire et réévaluer la correction précédemment autorisée")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action(async (executionId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const result = await execution.correct(executionId, {
          signal,
          onProgress: printExecutionProgress,
        });
        console.log("Correction produite et revue; le dépôt principal reste intact.");
        printExecutionStatus(execution.store, result);
        printExecutionCandidates(execution.store, result.id);
      });
    });
  });

program
  .command("exec-status")
  .description("Afficher l'état, le budget et l'arbitrage d'une exécution")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action((executionId?: string) => {
    withService(({ store }) => {
      printExecutionStatus(store, store.getExecution(executionId));
    });
  });

program
  .command("exec-doctor")
  .description("Diagnostiquer les verrous et budgets d'une exécution de code")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .option("--repair", "récupérer une exécution interrompue de façon conservatrice", false)
  .option("--force", "récupérer malgré un processus possiblement actif", false)
  .action(async (executionId: string | undefined, options: { repair: boolean; force: boolean }) => {
    await withServiceAsync(async ({ store, execution, candidateTest }) => {
      await diagnoseExecution(store, execution, candidateTest, executionId, options);
    });
  });

program
  .command("exec-candidates")
  .description("Lister les variantes, lots, intégrations et synthèses")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action((executionId?: string) => {
    withService(({ store }) => {
      const execution = store.getExecution(executionId);
      printExecutionCandidates(store, execution.id);
    });
  });

program
  .command("exec-test")
  .description("Exécuter une commande humaine sans shell sur un candidat dans un worktree jetable")
  .argument("<candidate>", "identifiant du candidat")
  .argument("<command...>", "commande et arguments; utilisez -- avant la commande")
  .option("--execution <id>", "identifiant; la plus récente par défaut")
  .option("--timeout <seconds>", "délai maximal entre 1 et 900 secondes", "300")
  .action(async (candidateId: string, command: string[], options: {
    execution?: string;
    timeout: string;
  }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ candidateTest }) => {
        printCandidateTestSafetyNotice(command);
        const run = await candidateTest.run({
          ...(options.execution ? { executionId: options.execution } : {}),
          candidateId,
          command,
          timeoutMs: parseTestTimeout(options.timeout),
          actorId: currentActorId(),
          signal,
        });
        printExecutionTestRun(run);
        if (run.status !== "PASSED") process.exitCode = 1;
      });
    });
  });

program
  .command("exec-tests")
  .description("Afficher les tests enregistrés d'une exécution")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action((executionId?: string) => {
    withService(({ store }) => {
      const execution = store.getExecution(executionId);
      printExecutionTests(store, execution.id);
    });
  });

program
  .command("exec-test-result")
  .description("Afficher la sortie enregistrée d'un test de candidat")
  .argument("<test>", "identifiant du test")
  .option("--json", "émettre l'enregistrement complet en JSON", false)
  .action((testRunId: string, options: { json: boolean }) => {
    withService(({ store }) => {
      const run = store.getExecutionTestRun(testRunId);
      if (options.json) console.log(JSON.stringify(run, null, 2));
      else printExecutionTestRun(run);
    });
  });

program
  .command("exec-diff")
  .description("Afficher le diff complet d'un candidat sans l'appliquer")
  .argument("<candidate>", "identifiant du candidat")
  .action((candidateId: string) => {
    withService(({ store }) => {
      const candidate = store.getExecutionCandidate(candidateId);
      console.log(candidate.diff);
    });
  });

program
  .command("exec-approve")
  .description("Valider humainement un candidat après inspection de son diff")
  .argument("[candidate]", "candidat; la présélection du coordinateur par défaut")
  .option("--execution <id>", "identifiant de l'exécution; la plus récente par défaut")
  .action(async (candidateId: string | undefined, options: { execution?: string }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const result = await execution.approveCandidate(
          options.execution,
          candidateId,
          currentActorId(),
          signal,
        );
        console.log("Candidat approuvé. Le dépôt principal n'est pas encore modifié.");
        printExecutionStatus(execution.store, result);
      });
    });
  });

program
  .command("exec-apply")
  .description("Appliquer au dépôt principal le diff préalablement approuvé")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action(async (executionId?: string) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ execution }) => {
        const result = await execution.applyApprovedCandidate(
          executionId,
          signal,
          currentActorId(),
        );
        console.log("Diff approuvé appliqué au dépôt principal; aucun commit ni push n'a été créé.");
        printExecutionStatus(execution.store, result);
      });
    });
  });

program
  .command("exec-cancel")
  .description("Annuler une exécution avant application")
  .argument("[execution]", "identifiant; la plus récente par défaut")
  .action((executionId?: string) => {
    withService(({ execution }) => {
      const result = execution.cancel(executionId, currentActorId());
      console.log("Exécution annulée; aucun candidat ne sera appliqué.");
      printExecutionStatus(execution.store, result);
    });
  });

program
  .command("demo")
  .description("Exécuter le brainstorming complet avec les agents simulés")
  .argument("<goal>", "objectif ou problème à traiter")
  .option("--budget <usd>", "budget simulé maximal en dollars", "0.10")
  .action(async (goal: string, options: { budget: string }) => {
    await withInterruptSignal(async (signal) => {
      await withServiceAsync(async ({ store, service }) => {
        let session = store.createSession({
          goal,
          budgetLimitMicrousd: parseUsd(options.budget),
          maxCycles: 1,
          agentProvider: "mock",
          agentModel: "deterministic-v1",
          createdBy: currentActorId(),
        });
        console.log(`Session de démonstration : ${session.id}`);
        while (session.state === "BRAINSTORMING") {
          console.log(`\n=== ${session.stage} ===\n`);
          session = await service.runCurrentStage(session.id, {
            signal,
            onContribution: printContribution,
          });
        }
        console.log("\n=== ARBITRAGE HUMAIN REQUIS ===\n");
        printStatus(store, session);
      });
    });
  });

program
  .command("eval-plan")
  .description("Valider un manifeste expérimental sans appeler de modèle")
  .argument("<manifest>", "fichier JSON décrivant la campagne")
  .action((manifestPath: string) => {
    const manifest = readEvaluationManifest(manifestPath);
    printEvaluationPlan(manifest);
  });

program
  .command("eval")
  .description("Exécuter une campagne A/B/C/D déclarée dans un manifeste")
  .argument("<manifest>", "fichier JSON décrivant la campagne")
  .option("--output <directory>", "répertoire de sortie")
  .option("--resume", "réutiliser les rapports déjà terminés sans refaire leurs appels", false)
  .option(
    "--retry-failed",
    "réessayer une exécution échouée malgré le risque de refacturation partielle",
    false,
  )
  .action(async (manifestPath: string, options: {
    output?: string;
    resume: boolean;
    retryFailed: boolean;
  }) => {
    const manifest = readEvaluationManifest(manifestPath);
    const configs = configsFromManifest(manifest);
    const outputDirectory = resolve(
      options.output ?? join(process.cwd(), ".open-day", "evaluations", manifest.studyId),
    );
    prepareEvaluationDirectory(outputDirectory, manifest);
    for (const config of configs) {
      const reportDirectory = evaluationReportDirectory(outputDirectory, config);
      const reportPath = join(reportDirectory, "report.json");
      const failurePath = join(reportDirectory, "failure.json");
      if (existsSync(reportPath) && !options.resume) {
        throw new Error(
          `Le rapport ${reportPath} existe déjà. Utilisez --resume pour éviter de refaire des appels payants.`,
        );
      }
      if (!existsSync(reportPath) && existsSync(failurePath) && !options.retryFailed) {
        throw new Error(
          `Une tentative précédente a échoué (${failurePath}). Vérifiez-la puis utilisez --retry-failed si vous acceptez un possible double coût.`,
        );
      }
    }

    const runtime = createRuntimeRouter();
    assertProvidersAvailable(runtime, providersRequiredByManifest(manifest));
    const controller = new AbortController();
    const onInterrupt = () => {
      if (!controller.signal.aborted) {
        console.error("\nAnnulation demandée : l'appel en cours va être interrompu.");
        controller.abort();
      }
    };
    process.once("SIGINT", onInterrupt);
    const summary: Array<{
      taskId: string;
      resourceRegime: string;
      reportPath: string;
      actualCostMicrousd: number;
      durationMs: number;
    }> = [];
    try {
      printEvaluationPlan(manifest);
      const runner = new EvaluationRunner(runtime);
      for (const [index, config] of configs.entries()) {
        controller.signal.throwIfAborted();
        const reportDirectory = evaluationReportDirectory(outputDirectory, config);
        ensurePrivateDirectory(reportDirectory);
        const reportPath = join(reportDirectory, "report.json");
        const failurePath = join(reportDirectory, "failure.json");
        console.log(
          `\n[${index + 1}/${configs.length}] ${config.taskId} — ${config.resourceRegime}`,
        );
        let report: EvaluationReport;
        if (existsSync(reportPath)) {
          report = readCompletedEvaluationReport(reportPath, config);
          console.log("Rapport existant validé : aucun appel de modèle effectué.");
        } else {
          try {
            report = await runner.run(config, controller.signal);
            writeJson(reportPath, report);
            if (existsSync(failurePath)) unlinkSync(failurePath);
          } catch (error) {
            writeJson(failurePath, {
              schemaVersion: 1,
              studyId: manifest.studyId,
              taskId: config.taskId,
              resourceRegime: config.resourceRegime,
              failedAt: new Date().toISOString(),
              safeMessage: error instanceof Error ? error.message : String(error),
              retryWarning:
                "Certains appels ont pu être facturés. Un nouvel essai peut entraîner un double coût.",
            });
            throw error;
          }
        }
        writeBlindEvaluationArtifacts(reportDirectory, report);
        const actualCostMicrousd = report.conditions.reduce(
          (total, condition) => total + condition.actualCostMicrousd,
          0,
        );
        const durationMs = report.conditions.reduce(
          (total, condition) => total + condition.durationMs,
          0,
        );
        summary.push({
          taskId: config.taskId,
          resourceRegime: config.resourceRegime,
          reportPath,
          actualCostMicrousd,
          durationMs,
        });
        console.log(
          `${existsSync(failurePath) ? "Repris" : "Terminé"} : ${formatUsd(actualCostMicrousd)} — ${reportPath}`,
        );
      }
      writeJson(join(outputDirectory, "campaign-summary.json"), {
        schemaVersion: 1,
        studyId: manifest.studyId,
        simulated: manifest.simulated,
        completedAt: new Date().toISOString(),
        runs: summary,
        totalActualCostMicrousd: summary.reduce(
          (total, item) => total + item.actualCostMicrousd,
          0,
        ),
      });
      console.log(`\nCampagne terminée : ${outputDirectory}`);
      if (manifest.simulated) {
        console.log("Le mode simulé valide l'infrastructure, pas l'hypothèse de qualité.");
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      await runtime.dispose();
    }
  });

program
  .command("eval-demo")
  .description("Exécuter les quatre conditions expérimentales avec des runtimes simulés")
  .argument("<goal>", "tâche de spécification ou d'architecture à comparer")
  .option("--budget <usd>", "budget simulé maximal par condition", "0.10")
  .option("--seed <seed>", "graine de randomisation", "open-day-pilot-1")
  .option("--output <directory>", "répertoire de sortie")
  .action(
    async (
      goal: string,
      options: { budget: string; seed: string; output?: string },
    ) => {
      const studyId = randomUUID();
      const router = new RuntimeRouterAdapter()
        .register("mock-a", new FakeRuntimeAdapter())
        .register("mock-b", new FakeRuntimeAdapter())
        .register("mock-c", new FakeRuntimeAdapter());
      try {
        const runner = new EvaluationRunner(router);
        const report = await runner.run({
          studyId,
          taskId: "task-1",
          goal,
          artifactType: "SPECIFICATION",
          baselineModel: { provider: "mock-a", model: "deterministic-a" },
          diverseModels: [
            { provider: "mock-a", model: "deterministic-a" },
            { provider: "mock-b", model: "deterministic-b" },
            { provider: "mock-c", model: "deterministic-c" },
          ],
          coordinatorModel: { provider: "mock-a", model: "deterministic-a" },
          maxCostPerConditionMicrousd: parseUsd(options.budget),
          maxOutputTokens: 1_000,
          resourceRegime: "PROTOCOL_NATIVE",
          maxOutputTokensPerCondition: null,
          seed: options.seed,
          simulated: true,
        });
        const blinded = createBlindPacket(report);
        const outputDirectory = resolve(
          options.output ?? join(process.cwd(), ".open-day", "evaluations", studyId),
        );
        ensurePrivateDirectory(outputDirectory);
        writeJson(join(outputDirectory, "report.json"), report);
        writeJson(join(outputDirectory, "blind-packet.json"), blinded.packet);
        writeJson(join(outputDirectory, "blind-key.json"), blinded.key);
        writeBlindArtifacts(join(outputDirectory, "blind-artifacts"), blinded.packet.artifacts);

        console.log("\nComparaison simulée terminée :\n");
        for (const result of report.conditions) {
          console.log(
            `${result.condition.padEnd(28)} ${String(result.calls.length).padStart(2)} appels  ${formatUsd(result.actualCostMicrousd).padStart(10)}  ${result.durationMs.toFixed(2)} ms`,
          );
        }
        console.log(`\nArtefacts : ${outputDirectory}`);
        console.log("Ces résultats valident le banc, pas la supériorité d'une condition.");
      } finally {
        await router.dispose();
      }
    },
  );

program
  .command("eval-score-template")
  .description("Créer une feuille de notation aveugle à compléter par un évaluateur")
  .argument("<campaign>", "répertoire d'une campagne terminée")
  .requiredOption("--evaluator <id>", "identifiant pseudonyme unique de l'évaluateur")
  .option("--output <file>", "fichier JSON à créer")
  .action((campaign: string, options: { evaluator: string; output?: string }) => {
    const campaignDirectory = resolve(campaign);
    const manifest = readEvaluationManifest(
      join(campaignDirectory, "manifest.snapshot.json"),
    );
    const configs = configsFromManifest(manifest);
    const evaluatorId = options.evaluator.trim();
    if (!evaluatorId) throw new Error("L'identifiant d'évaluateur ne peut pas être vide.");
    const safeEvaluatorId = evaluatorId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const outputPath = resolve(
      options.output ??
        join(campaignDirectory, "scores", `${safeEvaluatorId}.template.json`),
    );
    ensurePrivateDirectory(dirname(outputPath));
    const judgments = configs.map((config) => {
      const reportPath = join(
        evaluationReportDirectory(campaignDirectory, config),
        "report.json",
      );
      readCompletedEvaluationReport(reportPath, config);
      return {
        taskId: config.taskId,
        resourceRegime: config.resourceRegime,
        ratings: ["A", "B", "C", "D"].map((label) => ({
          label,
          ...Object.fromEntries(scoreCriteria.map((criterion) => [criterion, null])),
          overall: null,
          confidence: null,
          blockingDefects: [],
        })),
        ranking: [],
      };
    });
    writeJson(outputPath, {
      schemaVersion: 1,
      studyId: manifest.studyId,
      evaluatorId,
      completedAt: null,
      judgments,
    });
    console.log(`Feuille créée : ${outputPath}`);
    console.log(
      "Remplacez les valeurs null par des notes 1–5, fournissez un classement complet sans égalité, puis renseignez completedAt.",
    );
  });

program
  .command("eval-analyze")
  .description("Lever l'aveugle après notation et appliquer les seuils de décision")
  .argument("<campaign>", "répertoire d'une campagne terminée")
  .argument("<score-files...>", "feuilles JSON complétées")
  .option("--output <file>", "rapport JSON de sortie")
  .action(
    (
      campaign: string,
      scoreFiles: string[],
      options: { output?: string },
    ) => {
      const campaignDirectory = resolve(campaign);
      const manifest = readEvaluationManifest(
        join(campaignDirectory, "manifest.snapshot.json"),
      );
      const bundles = configsFromManifest(manifest).map((config) => {
        const reportDirectory = evaluationReportDirectory(campaignDirectory, config);
        const report = readCompletedEvaluationReport(
          join(reportDirectory, "report.json"),
          config,
        );
        const key = readBlindEvaluationKey(join(reportDirectory, "blind-key.json"));
        return { report, key };
      });
      const sheets = scoreFiles.map((file) => {
        const path = resolve(file);
        try {
          return parseScoreSheet(
            JSON.parse(readUtf8FileLimited(path, 5_000_000, "feuille de notation")),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Feuille invalide ${path} : ${reason}`);
        }
      });
      const analysis = analyzeEvaluationScores(bundles, sheets);
      const outputPath = resolve(
        options.output ?? join(campaignDirectory, "score-analysis.json"),
      );
      ensurePrivateDirectory(dirname(outputPath));
      writeJson(outputPath, analysis);
      for (const regime of analysis.regimes) {
        console.log(`\n${regime.resourceRegime}`);
        console.log(
          `Débat > parallèle : ${(regime.debateVsParallel.debateWinRate * 100).toFixed(1)} %`,
        );
        console.log(
          `Delta qualité critique : ${regime.debateVsParallel.criticalQualityDelta.toFixed(3)}`,
        );
        console.log(
          `Coût ×${regime.debateVsParallel.costRatio.toFixed(2)}, latence ×${regime.debateVsParallel.latencyRatio.toFixed(2)}`,
        );
        console.log(`Décision : ${regime.recommendation}`);
      }
      console.log(`\nRapport : ${outputPath}`);
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Erreur : ${message}`);
  process.exitCode = 1;
});

interface ServiceContext {
  store: ControlPlaneStore;
  service: DeliberationService;
  execution: ExecutionService;
  candidateTest: CandidateTestService;
  project: ProjectWorkflowService;
}

function createContext(): ServiceContext {
  const options = program.opts<{ database: string; actor: string }>();
  const store = new ControlPlaneStore(resolve(options.database));
  const runtime = createRuntimeRouter();
  const service = new DeliberationService(store, runtime, options.actor);
  const execution = new ExecutionService(store, runtime);
  return {
    store,
    service,
    execution,
    candidateTest: new CandidateTestService(store),
    project: new ProjectWorkflowService(store, service, execution),
  };
}

function currentActorId(): string {
  const actor = program.opts<{ actor: string }>().actor.trim();
  if (!actor) throw new Error("L'identifiant de l'acteur ne peut pas être vide.");
  if (actor.length > 200) {
    throw new Error("L'identifiant de l'acteur dépasse 200 caractères.");
  }
  return actor;
}

function createRuntimeRouter(): RuntimeRouterAdapter {
  const runtime = new RuntimeRouterAdapter().register("mock", new FakeRuntimeAdapter());
  const openAI = loadOpenAIConfigFromEnv();
  if (openAI.ok) runtime.register("openai", new OpenAIRuntimeAdapter(openAI.config));
  const anthropic = loadAnthropicConfigFromEnv();
  if (anthropic.ok) runtime.register("anthropic", new AnthropicRuntimeAdapter(anthropic.config));
  const google = loadGoogleConfigFromEnv();
  if (google.ok) runtime.register("google", new GoogleRuntimeAdapter(google.config));
  return runtime;
}

function withService(operation: (context: ServiceContext) => void): void {
  const context = createContext();
  try {
    operation(context);
  } finally {
    context.store.close();
  }
}

async function withServiceAsync(
  operation: (context: ServiceContext) => Promise<void>,
): Promise<void> {
  const context = createContext();
  try {
    await operation(context);
  } finally {
    await context.service.runtime.dispose();
    context.store.close();
  }
}

function printContribution(notice: ContributionNotice): void {
  console.log(`[${notice.stage}] ${notice.agent.displayName}`);
  console.log(`  ${notice.streamedSummary}`);
  console.log(`  message: ${notice.message.id}\n`);
}

function printExecutionProgress(notice: ExecutionProgressNotice): void {
  console.log(`[${notice.kind}] ${notice.agent.displayName}`);
  console.log(`  ${notice.text}\n`);
}

function printProjectSnapshot(
  store: ControlPlaneStore,
  snapshot: ProjectWorkflowSnapshot,
): void {
  console.log(`\nProjet     : ${snapshot.project.id}`);
  console.log(`Mode       : ${snapshot.project.mode}`);
  console.log(`État       : ${snapshot.project.status}`);
  console.log(`Phase      : ${snapshot.session.state}${snapshot.session.stage ? ` / ${snapshot.session.stage}` : ""}`);
  console.log(`Porte      : ${snapshot.gate}`);
  console.log(`Décision   : ${snapshot.summary}`);
  console.log(
    `Conception : ${formatUsd(snapshot.session.spentMicrousd)} / ${formatUsd(snapshot.session.budgetLimitMicrousd)}`,
  );
  if (snapshot.execution) {
    console.log(`Exécution  : ${snapshot.execution.id} / ${snapshot.execution.state}`);
    console.log(
      `Budget code: ${formatUsd(snapshot.execution.spentMicrousd)} / ${formatUsd(snapshot.execution.budgetLimitMicrousd)}`,
    );
    console.log(
      `Corrections: ${snapshot.execution.correctionRound}/${snapshot.execution.maxCorrectionRounds}`,
    );
    if (snapshot.execution.review) {
      console.log(
        `Arbitrage  : ${snapshot.execution.review.verdict} — ${snapshot.execution.review.publicSummary}`,
      );
    }
    if (snapshot.gate === "CANDIDATE_APPROVAL") {
      printExecutionCandidates(store, snapshot.execution.id);
      console.log(
        `Tester     : open-day project test --project ${snapshot.project.id} -- <commande>`,
      );
      if (snapshot.execution.correctionRound < snapshot.execution.maxCorrectionRounds) {
        console.log("Corriger   : open-day project revise \"<instructions>\"");
      }
    }
  }
  if (snapshot.gate === "ALIGNMENT_APPROVAL") {
    console.log(`Relire     : open-day transcript ${snapshot.session.id}`);
  } else if (snapshot.gate === "SPECIFICATION_FREEZE") {
    console.log(`Relire     : open-day spec ${snapshot.session.id}`);
  } else if (snapshot.gate === "ARCHITECTURE_APPROVAL") {
    console.log(`Relire     : open-day architecture ${snapshot.session.id}`);
  }
  if (snapshot.nextCommand) console.log(`Suite      : ${snapshot.nextCommand}`);
  else console.log("Suite      : aucune — workflow terminé");
}

function printExecutionStatus(store: ControlPlaneStore, execution: Execution): void {
  const current = store.getExecution(execution.id);
  const usage = store.getExecutionUsage(current.id);
  const candidates = store.getExecutionCandidates(current.id);
  const tests = store.getExecutionTestRuns(current.id);
  console.log(`\nObjectif   : ${current.goal}`);
  console.log(`Exécution  : ${current.id}`);
  console.log(`Mode       : ${current.mode}`);
  console.log(`État       : ${current.state}`);
  console.log(`Dépôt      : ${current.workspacePath}`);
  console.log(`Base Git   : ${current.baseCommit}`);
  console.log(
    `Budget     : ${formatUsd(current.spentMicrousd)} dépensé, ${formatUsd(current.reservedMicrousd)} réservé, plafond ${formatUsd(current.budgetLimitMicrousd)}`,
  );
  console.log(`Appels     : ${usage.filter((item) => item.status === "SETTLED").length}`);
  console.log(`Candidats  : ${candidates.length}`);
  console.log(
    `Tests      : ${tests.length} (${tests.filter((run) => run.status === "PASSED").length} réussi(s), ${tests.filter((run) => run.status === "RUNNING").length} actif(s))`,
  );
  console.log(
    `Corrections: ${current.correctionRound}/${current.maxCorrectionRounds}`,
  );
  if (current.plan) {
    console.log(
      `Lots       : ${current.plan.tasks.map((task) => `${task.id}→${task.assignedRole}`).join(", ")}`,
    );
  }
  if (current.review) {
    console.log(`Arbitrage  : ${current.review.verdict} — ${current.review.publicSummary}`);
  }
  if (current.selectedCandidateId) {
    console.log(`Sélection  : ${current.selectedCandidateId}`);
  }
  console.log(`Suite      : ${nextExecutionAction(current)}`);
}

function printExecutionCandidates(store: ControlPlaneStore, executionId: string): void {
  const candidates = store.getExecutionCandidates(executionId);
  const testRuns = store.getExecutionTestRuns(executionId);
  if (!candidates.length) {
    console.log("Aucun candidat n'a encore été produit.");
    return;
  }
  console.log("\nCandidats :");
  for (const candidate of candidates) {
    console.log(
      `- ${candidate.id}  ${candidate.kind.padEnd(11)} ${candidate.status.padEnd(8)} ${candidate.label}`,
    );
    console.log(`  ${candidate.changeSet.publicSummary}`);
    console.log(`  worktree: ${candidate.worktreePath}`);
    const latestTest = testRuns.filter((run) => run.candidateId === candidate.id).at(-1);
    if (latestTest) {
      console.log(`  test     : ${latestTest.status} (${latestTest.id})`);
    }
    console.log(`  voir     : open-day exec-diff ${candidate.id}`);
  }
}

function printCandidateTestSafetyNotice(command: string[]): void {
  console.log("\nCommande de test explicitement autorisée :");
  console.log(`  ${JSON.stringify(command)}`);
  console.log("Isolation : worktree Git jetable, HOME temporaire, environnement filtré, aucun shell.");
  console.log("Journal   : commande, arguments et sorties sont persistés; n'y exposez aucun secret.");
  console.log(
    "Attention : ce prototype n'isole pas le réseau ni le système d'exploitation; la commande conserve les droits du processus local.\n",
  );
}

function printExecutionTestRun(run: ExecutionTestRun): void {
  console.log(`\nTest       : ${run.id}`);
  console.log(`Candidat   : ${run.candidateId}`);
  console.log(`Commande   : ${JSON.stringify(run.command)}`);
  console.log(`État       : ${run.status}`);
  console.log(`Code       : ${run.exitCode ?? "—"}`);
  console.log(`Signal     : ${run.terminationSignal ?? "—"}`);
  console.log(`Durée      : ${run.durationMs ?? 0} ms`);
  if (run.stdout) console.log(`\nstdout :\n${boundedCliOutput(run.stdout)}`);
  if (run.stderr) console.error(`\nstderr :\n${boundedCliOutput(run.stderr)}`);
  if (run.outputTruncated) {
    console.log("Sortie      : capture tronquée à 1 Mo par flux.");
  }
  if (run.cleanupError) console.log(`Nettoyage  : attention — ${run.cleanupError}`);
  else console.log("Nettoyage  : terminé");
}

function printExecutionTests(store: ControlPlaneStore, executionId: string): void {
  const runs = store.getExecutionTestRuns(executionId);
  if (!runs.length) {
    console.log("Aucun test de candidat n'a été enregistré.");
    return;
  }
  console.log(`\nTests de l'exécution ${executionId} :`);
  for (const run of runs) {
    console.log(
      `- ${run.id}  ${run.status.padEnd(11)} candidat=${run.candidateId} durée=${run.durationMs ?? "—"}ms`,
    );
    console.log(`  commande : ${JSON.stringify(run.command)}`);
  }
}

function boundedCliOutput(value: string): string {
  const limit = 20_000;
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… ${value.length - limit} caractère(s) non affiché(s); la capture complète reste dans SQLite.`;
}

function nextExecutionAction(execution: Execution): string {
  if (execution.state === "PLAN_PENDING") return `open-day exec-plan ${execution.id}`;
  if (execution.state === "PLAN_REVIEW") return `open-day exec-approve-plan ${execution.id}`;
  if (execution.state === "PLAN_APPROVED") return `open-day exec-run ${execution.id}`;
  if (execution.state === "CORRECTION_PENDING") {
    return `open-day exec-correct ${execution.id}`;
  }
  if (execution.state === "RESULTS_REVIEW") {
    return `inspecter les diffs, puis exec-approve ou exec-request-correction`;
  }
  if (execution.state === "APPROVED") return `open-day exec-apply ${execution.id}`;
  if (execution.state === "APPLIED") return "relire et tester les changements, puis committer manuellement";
  return "aucune action automatique";
}

function printStatus(store: ControlPlaneStore, session: Session): void {
  const current = store.getSession(session.id);
  const usage = store.getUsage(current.id);
  const agents = store.getAgents(current.id);
  console.log(`\nObjectif : ${current.goal}`);
  console.log(`État     : ${current.state}${current.stage ? ` / ${current.stage}` : ""}`);
  console.log(`Cycle    : ${current.cycle}/${current.maxCycles}`);
  console.log(
    `Agents    : ${agents.map((agent) => `${agent.role}=${agent.provider}/${agent.model}`).join(", ") || "inconnus"}`,
  );
  console.log(
    `Budget   : ${formatUsd(current.spentMicrousd)} dépensé, ${formatUsd(current.reservedMicrousd)} réservé, plafond ${formatUsd(current.budgetLimitMicrousd)}`,
  );
  console.log(`Appels   : ${usage.filter((item) => item.status === "SETTLED").length}`);
  const unknownUsage = usage.filter((item) => item.status === "UNKNOWN").length;
  if (unknownUsage) {
    console.log(`Incertain : ${unknownUsage} appel(s), facturation plafonnée comptée par prudence`);
  }
  console.log(`Suite     : ${nextAction(current)}`);
}

function printHealthReport(report: ReturnType<ControlPlaneStore["inspectHealth"]>): void {
  console.log(`\nDiagnostic : session ${report.session.id}`);
  console.log(`SQLite     : ${report.sqliteOk ? "OK" : "ERREUR"}`);
  console.log(
    `Réserves  : ${report.reservedRecords} appel(s), ${formatUsd(report.reservedRecordsMicrousd)}`,
  );
  if (report.lease) {
    console.log(
      `Verrou     : pid ${report.lease.ownerPid} sur ${report.lease.ownerHost}, ${report.lease.state}/${report.lease.stage}, depuis ${report.lease.acquiredAt}`,
    );
  } else {
    console.log("Verrou     : aucun");
  }
  if (!report.issues.length) {
    console.log("Résultat   : sain");
    return;
  }
  console.log("Résultat   : attention");
  for (const issue of report.issues) console.log(`  - ${issue}`);
}

async function diagnoseExecution(
  store: ControlPlaneStore,
  executionService: ExecutionService,
  candidateTest: CandidateTestService,
  executionId: string | undefined,
  options: { repair: boolean; force: boolean },
): Promise<void> {
  let report = store.inspectExecutionHealth(executionId);
  printExecutionHealthReport(report);
  let runningTests = store
    .getExecutionTestRuns(report.execution.id)
    .filter((run) => run.status === "RUNNING");
  if (runningTests.length) {
    console.log(`Tests actifs: ${runningTests.length}`);
    for (const run of runningTests) {
      console.log(
        `  - ${run.id} propriétaire pid ${run.ownerPid}, enfant ${run.childPid ?? "inconnu"}, depuis ${run.startedAt}`,
      );
    }
  }
  if (!options.repair) return;
  if (report.lease && !options.force) {
    const sameHost = report.lease.ownerHost === hostname();
    const alive = sameHost && isProcessAlive(report.lease.ownerPid);
    if (alive) {
      throw new Error(
        `Le processus ${report.lease.ownerPid} semble actif. Arrêtez-le ou utilisez --force en connaissance du risque.`,
      );
    }
    if (!sameHost) {
      throw new Error(
        "Le verrou appartient à un autre hôte. Vérifiez-le puis utilisez --force si nécessaire.",
      );
    }
  }
  for (const run of runningTests) {
    if (!options.force) {
      const sameHost = run.ownerHost === hostname();
      if (!sameHost) {
        throw new Error(
          `Le test ${run.id} appartient à un autre hôte. Vérifiez-le puis utilisez --force si nécessaire.`,
        );
      }
      if (isProcessAlive(run.ownerPid) || (run.childPid && isProcessAlive(run.childPid))) {
        throw new Error(
          `Le test ${run.id} semble encore actif. Interrompez son processus ou utilisez --force en connaissance du risque.`,
        );
      }
    }
  }
  if (report.execution.state === "APPLYING") {
    const reconciliation = await executionService.reconcileApplication(
      report.execution.id,
    );
    console.log(
      reconciliation.status === "APPLIED"
        ? "Réconciliation Git : le diff était entièrement appliqué; l'exécution est finalisée."
        : "Réconciliation Git : le diff n'était pas appliqué; retour à la porte d'application.",
    );
  }
  const recovery = store.recoverInterruptedExecution(report.execution.id);
  if (recovery.recovered) {
    console.log(
      `Récupération fournisseur : ${recovery.reservationsMarkedUnknown} appel(s), ${formatUsd(recovery.conservativeCostMicrousd)} compté(s) avec prudence.`,
    );
  }
  for (const run of runningTests) {
    const recovered = await candidateTest.recoverInterrupted(run.id, currentActorId());
    console.log(`Test récupéré : ${recovered.id} → ${recovered.status}`);
  }
  if (!recovery.recovered && runningTests.length === 0) {
    console.log("Aucune récupération nécessaire.");
  }
  report = store.inspectExecutionHealth(report.execution.id);
  printExecutionHealthReport(report);
  runningTests = store
    .getExecutionTestRuns(report.execution.id)
    .filter((run) => run.status === "RUNNING");
  if (runningTests.length) console.log(`Tests encore actifs : ${runningTests.length}`);
}

function printExecutionHealthReport(
  report: ReturnType<ControlPlaneStore["inspectExecutionHealth"]>,
): void {
  console.log(`\nDiagnostic : exécution ${report.execution.id}`);
  console.log(`État       : ${report.execution.state}`);
  console.log(`SQLite     : ${report.sqliteOk ? "OK" : "ERREUR"}`);
  console.log(
    `Réserves  : ${report.reservedRecords} appel(s), ${formatUsd(report.reservedRecordsMicrousd)}`,
  );
  if (report.lease) {
    console.log(
      `Verrou     : pid ${report.lease.ownerPid} sur ${report.lease.ownerHost}, depuis ${report.lease.acquiredAt}`,
    );
  } else {
    console.log("Verrou     : aucun");
  }
  if (!report.issues.length) {
    console.log("Résultat   : sain");
    return;
  }
  console.log("Résultat   : attention");
  for (const issue of report.issues) console.log(`  - ${issue}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function nextAction(session: Session): string {
  if (session.state === "BRAINSTORMING" || session.state === "ARCHITECTURE_DEBATE") {
    return "open-day run";
  }
  if (session.state === "ALIGNMENT") return "open-day approve-alignment (après relecture)";
  if (session.state === "SPEC_REVIEW") return "open-day freeze-spec (après relecture)";
  if (session.state === "SPEC_FROZEN") return "open-day start-architecture";
  if (session.state === "ARCHITECTURE_REVIEW") {
    return "open-day architecture, éventuellement revise-architecture, puis approve-architecture";
  }
  if (session.state === "PAUSED") return "open-day resume";
  if (session.state === "BUDGET_EXHAUSTED") return "créer une nouvelle session avec un budget adapté";
  return "aucune action automatique";
}

function printTranscriptMessage(message: Message, agentNames: Map<string, string>): void {
  const author = message.agentId ? (agentNames.get(message.agentId) ?? message.agentId) : "Utilisateur";
  const content = message.content as Record<string, unknown>;
  const summary =
    typeof content.publicSummary === "string"
      ? content.publicSummary
      : typeof content.text === "string"
        ? content.text
        : JSON.stringify(content);
  console.log(`\n[${message.phase}/${message.kind}] ${author} — ${message.createdAt}`);
  if (message.replyToMessageId) console.log(`↳ réponse à ${message.replyToMessageId}`);
  console.log(summary);
}

function parseUsd(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Le budget doit être un montant positif en dollars.");
  }
  const microusd = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(microusd)) {
    throw new Error("Le budget dépasse la plage numérique prise en charge.");
  }
  return microusd;
}

function parsePositiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} doit être un entier positif.`);
  }
  return number;
}

function parseNonNegativeInteger(value: string, name: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new Error(`${name} doit être un entier compris entre 0 et ${maximum}.`);
  }
  return number;
}

function parseTestTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 900) {
    throw new Error("timeout doit être un nombre compris entre 1 et 900 secondes.");
  }
  return Math.round(seconds * 1_000);
}

function formatUsd(microusd: number): string {
  return `${(microusd / 1_000_000).toFixed(4)} $`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  restrictFile(path);
}

function writeBlindArtifacts(
  directory: string,
  artifacts: Array<{ label: string; artifactMarkdown: string }>,
): void {
  ensurePrivateDirectory(directory);
  for (const artifact of artifacts) {
    writeFileSync(join(directory, `${artifact.label}.md`), artifact.artifactMarkdown, {
      encoding: "utf8",
      mode: 0o600,
    });
    restrictFile(join(directory, `${artifact.label}.md`));
  }
}

type EvaluationRunConfig = ReturnType<typeof configsFromManifest>[number];

function evaluationReportDirectory(
  outputDirectory: string,
  config: EvaluationRunConfig,
): string {
  return join(outputDirectory, config.taskId, config.resourceRegime);
}

function prepareEvaluationDirectory(
  outputDirectory: string,
  manifest: EvaluationManifest,
): void {
  ensurePrivateDirectory(outputDirectory);
  const snapshotPath = join(outputDirectory, "manifest.snapshot.json");
  if (!existsSync(snapshotPath)) {
    writeJson(snapshotPath, manifest);
    return;
  }
  let existing: unknown;
  try {
    existing = JSON.parse(
      readUtf8FileLimited(snapshotPath, 1_000_000, "instantané du manifeste"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`L'instantané existant est illisible : ${reason}`);
  }
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
    throw new Error(
      `Le répertoire ${outputDirectory} appartient à un autre manifeste. Choisissez un nouveau --output.`,
    );
  }
}

function readCompletedEvaluationReport(
  reportPath: string,
  config: EvaluationRunConfig,
): EvaluationReport {
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      readUtf8FileLimited(reportPath, 50_000_000, "rapport expérimental"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Le rapport existant ${reportPath} est illisible : ${reason}`);
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Le rapport existant ${reportPath} n'est pas un objet JSON.`);
  }
  const report = candidate as Partial<EvaluationReport>;
  const conditions = report.conditions;
  const actualConditions = Array.isArray(conditions)
    ? conditions.map((condition) =>
        condition && typeof condition === "object" ? condition.condition : null,
      )
    : [];
  if (
    report.schemaVersion !== 2 ||
    report.studyId !== config.studyId ||
    report.taskId !== config.taskId ||
    report.resourceRegime !== config.resourceRegime ||
    report.artifactType !== config.artifactType ||
    actualConditions.length !== evaluationConditions.length ||
    evaluationConditions.some((condition) => !actualConditions.includes(condition))
  ) {
    throw new Error(
      `Le rapport existant ${reportPath} ne correspond pas à l'exécution demandée.`,
    );
  }
  for (const condition of conditions ?? []) {
    if (
      !condition ||
      typeof condition !== "object" ||
      !Number.isFinite(condition.actualCostMicrousd) ||
      condition.actualCostMicrousd < 0 ||
      !Number.isFinite(condition.durationMs) ||
      condition.durationMs < 0
    ) {
      throw new Error(`Le rapport existant ${reportPath} contient des métriques invalides.`);
    }
    synthesisOutputSchema.parse(condition.finalOutput);
  }
  return report as EvaluationReport;
}

function readBlindEvaluationKey(path: string): BlindEvaluationKey {
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      readUtf8FileLimited(path, 1_000_000, "clé de levée d'aveugle"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Clé aveugle illisible ${path} : ${reason}`);
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Clé aveugle invalide ${path}.`);
  }
  const key = candidate as Partial<BlindEvaluationKey>;
  if (
    typeof key.studyId !== "string" ||
    typeof key.taskId !== "string" ||
    !Array.isArray(key.mapping) ||
    key.mapping.length !== evaluationConditions.length
  ) {
    throw new Error(`Clé aveugle invalide ${path}.`);
  }
  const labels = key.mapping.map((item) => item?.label);
  const conditions = key.mapping.map((item) => item?.condition);
  if (
    new Set(labels).size !== 4 ||
    !["A", "B", "C", "D"].every((label) => labels.includes(label)) ||
    new Set(conditions).size !== evaluationConditions.length ||
    evaluationConditions.some((condition) => !conditions.includes(condition))
  ) {
    throw new Error(`Clé aveugle incomplète ${path}.`);
  }
  return key as BlindEvaluationKey;
}

function writeBlindEvaluationArtifacts(
  reportDirectory: string,
  report: EvaluationReport,
): void {
  const blinded = createBlindPacket(report);
  writeJson(join(reportDirectory, "blind-packet.json"), blinded.packet);
  writeJson(join(reportDirectory, "blind-key.json"), blinded.key);
  writeBlindArtifacts(
    join(reportDirectory, "blind-artifacts"),
    blinded.packet.artifacts,
  );
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Certains systèmes, notamment Windows, n'appliquent pas les modes POSIX.
  }
}

function restrictFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Certains systèmes, notamment Windows, n'appliquent pas les modes POSIX.
  }
}

type Provider = "mock" | "openai" | "anthropic" | "google";

function parseProjectMode(value: string): ProjectMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "design" || normalized === "brainstorm") return "DESIGN";
  if (normalized === "coordinated" || normalized === "coordonne" || normalized === "coordonné") {
    return "COORDINATED";
  }
  if (normalized === "competitive" || normalized === "concurrent") {
    return "COMPETITIVE";
  }
  throw new Error("Le mode doit être design, coordinated ou competitive.");
}

function parseExecutionMode(value: string): ExecutionMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "coordinated" || normalized === "coordonne" || normalized === "coordonné") {
    return "COORDINATED";
  }
  if (normalized === "competitive" || normalized === "concurrent") {
    return "COMPETITIVE";
  }
  throw new Error("Le mode doit être coordinated ou competitive.");
}

function parseProvider(value: string): Provider {
  const normalized = value.trim().toLowerCase();
  if (!["mock", "openai", "anthropic", "google"].includes(normalized)) {
    throw new Error("Le fournisseur doit être mock, openai, anthropic ou google.");
  }
  return normalized as Provider;
}

function resolveModel(provider: Provider, explicitModel?: string): string {
  if (provider === "mock") return explicitModel?.trim() || "deterministic-v1";
  const environmentName: Record<Exclude<Provider, "mock">, string> = {
    openai: "OPEN_DAY_OPENAI_MODEL",
    anthropic: "OPEN_DAY_ANTHROPIC_MODEL",
    google: "OPEN_DAY_GOOGLE_MODEL",
  };
  const model = explicitModel?.trim() || process.env[environmentName[provider]]?.trim();
  if (!model) {
    throw new Error(`Fournissez --model ou définissez ${environmentName[provider]}.`);
  }
  return model;
}

function parseAgentSelection(
  value: string | undefined,
  fallback: { provider: Provider; model: string },
): { provider: Provider; model: string } {
  if (!value?.trim()) return fallback;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Affectation invalide « ${value} ». Utilisez provider:model, par exemple anthropic:mon-modele.`,
    );
  }
  const provider = parseProvider(value.slice(0, separator));
  const model = value.slice(separator + 1).trim();
  if (!model) throw new Error(`Le modèle est absent dans l'affectation « ${value} ».`);
  return { provider, model };
}

function requireProviderConfiguration(provider: Provider): void {
  if (provider === "mock") return;
  const loaders = {
    openai: loadOpenAIConfigFromEnv,
    anthropic: loadAnthropicConfigFromEnv,
    google: loadGoogleConfigFromEnv,
  } as const;
  const result = loaders[provider]();
  if (!result.ok) {
    throw new Error(`Configuration ${provider} incomplète : ${result.errors.join(" ")}`);
  }
}

function printProviderConfiguration(
  provider: Exclude<Provider, "mock">,
  result: ReturnType<typeof loadOpenAIConfigFromEnv>,
  defaultModel: string | undefined,
): void {
  if (result.ok) {
    const model = defaultModel?.trim();
    console.log(
      `${provider.padEnd(9)}: configuré${model ? `, modèle par défaut ${model}` : ", modèle à fournir avec --model"}`,
    );
    console.log(
      `           tarifs ${result.config.inputUsdPerMillionTokens}/${result.config.outputUsdPerMillionTokens} $ par million de tokens entrée/sortie`,
    );
  } else {
    console.log(`${provider.padEnd(9)}: non configuré`);
    for (const error of result.errors) console.log(`           - ${error}`);
  }
}

function readEvaluationManifest(path: string): EvaluationManifest {
  const absolutePath = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(
      readUtf8FileLimited(absolutePath, 1_000_000, "manifeste expérimental"),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Impossible de lire le manifeste ${absolutePath} : ${reason}`);
  }
  try {
    return parseEvaluationManifest(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Manifeste invalide : ${reason}`);
  }
}

function readUtf8FileLimited(path: string, maximumBytes: number, label: string): string {
  const size = statSync(path).size;
  if (size > maximumBytes) {
    throw new Error(
      `Le fichier ${label} dépasse la limite de ${maximumBytes} octets (${size} octets).`,
    );
  }
  return readFileSync(path, "utf8");
}

function printEvaluationPlan(manifest: EvaluationManifest): void {
  const configs = configsFromManifest(manifest);
  const calls = configs.length * 22;
  const maximumMicrousd =
    configs.length * 4 * Math.round(manifest.maxCostPerConditionUsd * 1_000_000);
  console.log(`Étude      : ${manifest.studyId}`);
  console.log(`Mode        : ${manifest.simulated ? "simulé" : "API réelles"}`);
  console.log(`Tâches      : ${manifest.tasks.length}`);
  console.log(`Régimes     : ${manifest.resourceRegimes.join(", ")}`);
  console.log(`Exécutions  : ${configs.length} (22 appels nominaux chacune, ${calls} au total)`);
  console.log(`Fournisseurs: ${providersRequiredByManifest(manifest).join(", ")}`);
  console.log(`Plafond coût: ${formatUsd(maximumMicrousd)} au total`);
  console.log("Le plafond est une limite de sécurité, pas une estimation de dépense.");
}

function assertProvidersAvailable(
  runtime: RuntimeRouterAdapter,
  providers: string[],
): void {
  const missing = providers.filter((provider) => !runtime.has(provider));
  if (missing.length) {
    throw new Error(
      `Fournisseurs absents ou non configurés : ${missing.join(", ")}. Lancez open-day providers.`,
    );
  }
}

async function withInterruptSignal(
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => {
    if (!controller.signal.aborted) {
      console.error("\nAnnulation demandée : arrêt propre de l'appel en cours.");
      controller.abort();
    }
  };
  process.once("SIGINT", onInterrupt);
  try {
    await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
