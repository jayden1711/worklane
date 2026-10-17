import { Learnings } from './learnings.js';
export declare const SUPERFAN_ROLE = "superfan";
/** The machine's superfan's lock and state, in the slot directory every coordinator shares. */
export declare const MACHINE_LOCK = "superfan-machine.lock";
export declare const MACHINE_STATE = "superfan-machine.json";
export declare abstract class SuperfanWatch extends Learnings {
    /** The superfan pass in flight. */
    protected superfanRun: Promise<void>;
    private superfanBusy;
    private machineSuperfan;
    /** Start a superfan pass (the instance's, then the machine's if this coordinator holds it); each is skipped until due. */
    checkSuperfan(): Promise<void>;
    private get superfanSlots();
    /** The machine's superfan: taken if free (or its holder died), kept once held. */
    private takeMachineSuperfan;
    /** Step down from the machine's superfan (shutting down, or its config is gone): another coordinator takes over. */
    protected superfanStop(): void;
    private superfanDeps;
}
