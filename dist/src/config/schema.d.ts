import { z } from 'zod';
export declare const Area: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodString;
    paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const ProjectConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    project: z.ZodObject<{
        name: z.ZodString;
        repo: z.ZodString;
        default_branch: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>;
    mode: z.ZodDefault<z.ZodEnum<{
        local: "local";
        shared: "shared";
    }>>;
    backlog: z.ZodDefault<z.ZodEnum<{
        file: "file";
        github: "github";
    }>>;
    runner: z.ZodDefault<z.ZodEnum<{
        local: "local";
        ci: "ci";
        "remote-machine": "remote-machine";
    }>>;
    agent_runtime: z.ZodPrefault<z.ZodObject<{
        kind: z.ZodDefault<z.ZodEnum<{
            cli: "cli";
            sdk: "sdk";
        }>>;
        max_concurrency: z.ZodDefault<z.ZodNumber>;
        run_windows: z.ZodDefault<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    land_mode: z.ZodDefault<z.ZodEnum<{
        direct: "direct";
        pr: "pr";
    }>>;
    os: z.ZodDefault<z.ZodEnum<{
        auto: "auto";
        macos: "macos";
        linux: "linux";
        "windows-wsl": "windows-wsl";
    }>>;
    owners: z.ZodObject<{
        default: z.ZodString;
        writers: z.ZodArray<z.ZodString>;
        areas: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            owner: z.ZodString;
            paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
            labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    reports: z.ZodPrefault<z.ZodObject<{
        times: z.ZodDefault<z.ZodArray<z.ZodString>>;
        to: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const RoleNames: readonly ["chief_of_staff", "pm", "workers", "evaluator", "security", "qa_playtester", "researcher", "red_attributor", "ci_repair", "monitor", "release_prep"];
export declare const AgentsConfig: z.ZodObject<{
    stage: z.ZodNumber;
    daily_budget_usd: z.ZodNumber;
    roles: z.ZodRecord<z.ZodEnum<{
        chief_of_staff: "chief_of_staff";
        pm: "pm";
        workers: "workers";
        evaluator: "evaluator";
        security: "security";
        qa_playtester: "qa_playtester";
        researcher: "researcher";
        red_attributor: "red_attributor";
        ci_repair: "ci_repair";
        monitor: "monitor";
        release_prep: "release_prep";
    }> & z.core.$partial, z.ZodObject<{
        enabled: z.ZodBoolean;
        model: z.ZodString;
        count: z.ZodOptional<z.ZodNumber>;
        max: z.ZodOptional<z.ZodNumber>;
        hard_issues_model: z.ZodOptional<z.ZodString>;
        max_per_day: z.ZodOptional<z.ZodNumber>;
        max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
        applies_to: z.ZodOptional<z.ZodArray<z.ZodString>>;
        budget_usd: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    auto_land: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const RuleMatch: z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodObject<{
        pattern: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    cli_env: z.ZodObject<{
        cli: z.ZodString;
        subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
        flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
        flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environments: z.ZodArray<z.ZodString>;
        env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        resolver: z.ZodDefault<z.ZodEnum<{
            none: "none";
            railway: "railway";
        }>>;
        unresolved: z.ZodDefault<z.ZodEnum<{
            match: "match";
            no_match: "no_match";
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    connection: z.ZodObject<{
        fingerprints: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    path: z.ZodObject<{
        globs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export declare const Rule: z.ZodObject<{
    id: z.ZodString;
    action: z.ZodEnum<{
        ask: "ask";
        block: "block";
    }>;
    reason: z.ZodString;
    applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        agent: "agent";
        interactive: "interactive";
    }>>>;
    match: z.ZodUnion<readonly [z.ZodObject<{
        command: z.ZodObject<{
            pattern: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        cli_env: z.ZodObject<{
            cli: z.ZodString;
            subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
            flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
            flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
            environments: z.ZodArray<z.ZodString>;
            env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
            resolver: z.ZodDefault<z.ZodEnum<{
                none: "none";
                railway: "railway";
            }>>;
            unresolved: z.ZodDefault<z.ZodEnum<{
                match: "match";
                no_match: "no_match";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        connection: z.ZodObject<{
            fingerprints: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodObject<{
            globs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    unless: z.ZodOptional<z.ZodObject<{
        pattern: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const Example: z.ZodUnion<readonly [z.ZodObject<{
    bash: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    tool: z.ZodEnum<{
        Edit: "Edit";
        Write: "Write";
        MultiEdit: "MultiEdit";
        NotebookEdit: "NotebookEdit";
        Read: "Read";
        Grep: "Grep";
    }>;
    path: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    fetch: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>]>;
export declare const GuardrailsConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        action: z.ZodEnum<{
            ask: "ask";
            block: "block";
        }>;
        reason: z.ZodString;
        applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            agent: "agent";
            interactive: "interactive";
        }>>>;
        match: z.ZodUnion<readonly [z.ZodObject<{
            command: z.ZodObject<{
                pattern: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            cli_env: z.ZodObject<{
                cli: z.ZodString;
                subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
                flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
                flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
                environments: z.ZodArray<z.ZodString>;
                env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
                resolver: z.ZodDefault<z.ZodEnum<{
                    none: "none";
                    railway: "railway";
                }>>;
                unresolved: z.ZodDefault<z.ZodEnum<{
                    match: "match";
                    no_match: "no_match";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            connection: z.ZodObject<{
                fingerprints: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            path: z.ZodObject<{
                globs: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>]>;
        unless: z.ZodOptional<z.ZodObject<{
            pattern: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        command: z.ZodString;
        key: z.ZodString;
    }, z.core.$strict>>>;
    protected_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    secret_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    credential_stores: z.ZodDefault<z.ZodArray<z.ZodString>>;
    network: z.ZodPrefault<z.ZodObject<{
        allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    pre_approved: z.ZodDefault<z.ZodArray<z.ZodString>>;
    examples: z.ZodPrefault<z.ZodObject<{
        must_block: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Edit: "Edit";
                Write: "Write";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        must_ask: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Edit: "Edit";
                Write: "Write";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        must_allow: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Edit: "Edit";
                Write: "Write";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        linked_environments: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const TestsConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    runner: z.ZodObject<{
        kind: z.ZodLiteral<"command">;
        changed: z.ZodString;
        full: z.ZodString;
        one: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    vacuity: z.ZodOptional<z.ZodObject<{
        test_globs: z.ZodArray<z.ZodString>;
        assertion_pattern: z.ZodString;
        app_paths: z.ZodArray<z.ZodString>;
        dynamic: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    stop_gate: z.ZodPrefault<z.ZodObject<{
        timeout_s: z.ZodDefault<z.ZodNumber>;
        lock_wait_s: z.ZodDefault<z.ZodNumber>;
        busy_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    worktree: z.ZodPrefault<z.ZodObject<{
        root: z.ZodDefault<z.ZodString>;
        setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
        est_size_gb: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    land: z.ZodPrefault<z.ZodObject<{
        pre: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    failures: z.ZodOptional<z.ZodObject<{
        section: z.ZodString;
        item: z.ZodString;
    }, z.core.$strict>>;
    idle_probe: z.ZodOptional<z.ZodString>;
    checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        max_disk_used_pct: z.ZodOptional<z.ZodNumber>;
        exclusive: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const ReviewConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    money_path_source: z.ZodOptional<z.ZodObject<{
        file: z.ZodString;
        pattern: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    levels: z.ZodObject<{
        L0_auto: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            max_lines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        L1_evaluator: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            max_lines: z.ZodOptional<z.ZodNumber>;
            max_files: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        L2_notify: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        L3_human: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            over_lines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const DeployConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    prod_read: z.ZodOptional<z.ZodObject<{
        via: z.ZodLiteral<"railway-ssh">;
        service: z.ZodString;
        environment: z.ZodString;
        url_var: z.ZodString;
        max_rows: z.ZodDefault<z.ZodNumber>;
        timeout_s: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    environments: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        trigger: z.ZodOptional<z.ZodString>;
        verify: z.ZodString;
        production: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type AgentsConfig = z.infer<typeof AgentsConfig>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfig>;
export type Rule = z.infer<typeof Rule>;
export type Example = z.infer<typeof Example>;
export type TestsConfig = z.infer<typeof TestsConfig>;
export type ReviewConfig = z.infer<typeof ReviewConfig>;
export type DeployConfig = z.infer<typeof DeployConfig>;
export declare const FILES: {
    readonly 'config.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        project: z.ZodObject<{
            name: z.ZodString;
            repo: z.ZodString;
            default_branch: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>;
        mode: z.ZodDefault<z.ZodEnum<{
            local: "local";
            shared: "shared";
        }>>;
        backlog: z.ZodDefault<z.ZodEnum<{
            file: "file";
            github: "github";
        }>>;
        runner: z.ZodDefault<z.ZodEnum<{
            local: "local";
            ci: "ci";
            "remote-machine": "remote-machine";
        }>>;
        agent_runtime: z.ZodPrefault<z.ZodObject<{
            kind: z.ZodDefault<z.ZodEnum<{
                cli: "cli";
                sdk: "sdk";
            }>>;
            max_concurrency: z.ZodDefault<z.ZodNumber>;
            run_windows: z.ZodDefault<z.ZodArray<z.ZodObject<{
                from: z.ZodString;
                to: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        land_mode: z.ZodDefault<z.ZodEnum<{
            direct: "direct";
            pr: "pr";
        }>>;
        os: z.ZodDefault<z.ZodEnum<{
            auto: "auto";
            macos: "macos";
            linux: "linux";
            "windows-wsl": "windows-wsl";
        }>>;
        owners: z.ZodObject<{
            default: z.ZodString;
            writers: z.ZodArray<z.ZodString>;
            areas: z.ZodDefault<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                owner: z.ZodString;
                paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
                labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        reports: z.ZodPrefault<z.ZodObject<{
            times: z.ZodDefault<z.ZodArray<z.ZodString>>;
            to: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'agents.yaml': z.ZodObject<{
        stage: z.ZodNumber;
        daily_budget_usd: z.ZodNumber;
        roles: z.ZodRecord<z.ZodEnum<{
            chief_of_staff: "chief_of_staff";
            pm: "pm";
            workers: "workers";
            evaluator: "evaluator";
            security: "security";
            qa_playtester: "qa_playtester";
            researcher: "researcher";
            red_attributor: "red_attributor";
            ci_repair: "ci_repair";
            monitor: "monitor";
            release_prep: "release_prep";
        }> & z.core.$partial, z.ZodObject<{
            enabled: z.ZodBoolean;
            model: z.ZodString;
            count: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            hard_issues_model: z.ZodOptional<z.ZodString>;
            max_per_day: z.ZodOptional<z.ZodNumber>;
            max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
            applies_to: z.ZodOptional<z.ZodArray<z.ZodString>>;
            budget_usd: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        auto_land: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    readonly 'guardrails.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            action: z.ZodEnum<{
                ask: "ask";
                block: "block";
            }>;
            reason: z.ZodString;
            applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                agent: "agent";
                interactive: "interactive";
            }>>>;
            match: z.ZodUnion<readonly [z.ZodObject<{
                command: z.ZodObject<{
                    pattern: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                cli_env: z.ZodObject<{
                    cli: z.ZodString;
                    subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    environments: z.ZodArray<z.ZodString>;
                    env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    resolver: z.ZodDefault<z.ZodEnum<{
                        none: "none";
                        railway: "railway";
                    }>>;
                    unresolved: z.ZodDefault<z.ZodEnum<{
                        match: "match";
                        no_match: "no_match";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                connection: z.ZodObject<{
                    fingerprints: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                path: z.ZodObject<{
                    globs: z.ZodArray<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>]>;
            unless: z.ZodOptional<z.ZodObject<{
                pattern: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
        fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            command: z.ZodString;
            key: z.ZodString;
        }, z.core.$strict>>>;
        protected_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        secret_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        credential_stores: z.ZodDefault<z.ZodArray<z.ZodString>>;
        network: z.ZodPrefault<z.ZodObject<{
            allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        pre_approved: z.ZodDefault<z.ZodArray<z.ZodString>>;
        examples: z.ZodPrefault<z.ZodObject<{
            must_block: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Edit: "Edit";
                    Write: "Write";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            must_ask: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Edit: "Edit";
                    Write: "Write";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            must_allow: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Edit: "Edit";
                    Write: "Write";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
            linked_environments: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'tests.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        runner: z.ZodObject<{
            kind: z.ZodLiteral<"command">;
            changed: z.ZodString;
            full: z.ZodString;
            one: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        vacuity: z.ZodOptional<z.ZodObject<{
            test_globs: z.ZodArray<z.ZodString>;
            assertion_pattern: z.ZodString;
            app_paths: z.ZodArray<z.ZodString>;
            dynamic: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        stop_gate: z.ZodPrefault<z.ZodObject<{
            timeout_s: z.ZodDefault<z.ZodNumber>;
            lock_wait_s: z.ZodDefault<z.ZodNumber>;
            busy_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        worktree: z.ZodPrefault<z.ZodObject<{
            root: z.ZodDefault<z.ZodString>;
            setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
            est_size_gb: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        land: z.ZodPrefault<z.ZodObject<{
            pre: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        failures: z.ZodOptional<z.ZodObject<{
            section: z.ZodString;
            item: z.ZodString;
        }, z.core.$strict>>;
        idle_probe: z.ZodOptional<z.ZodString>;
        checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        tiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodString;
            max_disk_used_pct: z.ZodOptional<z.ZodNumber>;
            exclusive: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    readonly 'review.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        money_path_source: z.ZodOptional<z.ZodObject<{
            file: z.ZodString;
            pattern: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        levels: z.ZodObject<{
            L0_auto: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                max_lines: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            L1_evaluator: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                max_lines: z.ZodOptional<z.ZodNumber>;
                max_files: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            L2_notify: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
            L3_human: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                over_lines: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    readonly 'deploy.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        prod_read: z.ZodOptional<z.ZodObject<{
            via: z.ZodLiteral<"railway-ssh">;
            service: z.ZodString;
            environment: z.ZodString;
            url_var: z.ZodString;
            max_rows: z.ZodDefault<z.ZodNumber>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        environments: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            trigger: z.ZodOptional<z.ZodString>;
            verify: z.ZodString;
            production: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
};
