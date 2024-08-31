import { CURRENT_TRACING_VERSION } from "./constants";
import { Collector, CollectorSingleton } from "./tracing";
import { EvaluateEvent, Span, Trace, Event, SpanType, DEFAULT_SPAN_TYPE, NodeInput } from "./types";
import { newUUID } from "./utils";

interface CreateSpanProps {
    input?: any | null;
    metadata?: Record<string, any> | null;
    attributes?: Record<string, any>;
    spanType?: SpanType;
};

export class ObservationContext {
    protected observation: Span | Trace;
    public parent: ObservationContext | null;
    public children: Record<string, SpanContext>;
    protected collector: Collector;

    constructor(observation: Span | Trace, parent: ObservationContext | null) {
        this.observation = observation;
        this.parent = parent;
        this.children = {};
        this.collector = CollectorSingleton.getInstance();
    }

    public id(): string {
        return this.observation.id;
    }

    public span(
        name: string,
        {
            input,
            metadata,
            attributes,
            spanType,
        }: CreateSpanProps = {}
    ): SpanContext {
        const parent = this as ObservationContext;
        const parentSpanId =
            parent instanceof SpanContext ? parent.observation.id : null;

        const traceId = parent instanceof TraceContext
            ? parent.observation.id
            : (parent.observation as Span).traceId;

        const span = {
            version: CURRENT_TRACING_VERSION,
            spanType: spanType ?? DEFAULT_SPAN_TYPE,
            id: newUUID(),
            parentSpanId,
            traceId,
            name,
            startTime: new Date(),
            endTime: null,
            attributes: attributes ?? {},
            input: input ?? null,
            output: null,
            metadata: metadata ?? null,
            evaluateEvents: [],
            events: [],
        } as Span;

        const spanContext = new SpanContext(span, this);
        this.children[span.id] = spanContext;
        return spanContext;
    }
}

interface UpdateSpanProps {
    input?: any | null;
    output?: any | null;
    metadata?: Record<string, any> | null;
    attributes?: Record<string, any>;
    evaluateEvents?: EvaluateEvent[];
    override?: boolean;
};

interface SpanEventProps {
    value?: string | number | boolean;
    timestamp?: Date;
};

interface SpanEvaluateEventProps {
    timestamp?: Date;
};

export class SpanContext extends ObservationContext {
    private inerSpan: Span;

    constructor(span: Span, parent: ObservationContext) {
        super(span, parent);
        this.inerSpan = span;
    }

    public end({
        input,
        output,
        metadata,
        attributes,
        evaluateEvents,
        override
    }: UpdateSpanProps = {}): SpanContext {
        if (this.children && Object.keys(this.children).length > 0) {
            console.warn(`Ending span ${this.observation.id}, but it has children that have not been finalized.` +
                ` Children: ${Object.values(this.children).map((child) => child.inerSpan.name)}`);
        }

        delete this.getParent().children[this.inerSpan.id];
        this.innerUpdate(input, output, metadata, attributes, evaluateEvents, override, true);

        return this;
    }

    public update({
        input,
        output,
        metadata,
        attributes,
        evaluateEvents,
        override
    }: UpdateSpanProps): SpanContext {
        return this.innerUpdate(input, output, metadata, attributes, evaluateEvents, override, false);
    }

    public event(name: string, {
        value,
        timestamp,
    }: SpanEventProps = {}): SpanContext {
        const event = {
            id: newUUID(),
            templateName: name,
            timestamp: timestamp ?? new Date(),
            spanId: this.inerSpan.id,
            value: value ?? null,
        } as Event;

        this.inerSpan.events.push(event);
        return this;
    }

    /**
     * Evaluate an event with the given name using the specified evaluator and data.
     * 
     * The evaluator refers to the name of the Laminar pipeline.
     * The data is passed as input to the evaluator pipeline, meaning you must specify the data you want to evaluate. The prompt
     * of the evaluator will be templated with the keys of the data object.
     * Typically, you would pass the output of LLM generation, users' messages, and other relevant data to `data`.
     * 
     * @param {string} name - Name of the event.
     * @param {string} evaluator - Name of the evaluator pipeline.
     * @param {Record<string, NodeInput>} data - Data to be used when evaluating the event.
     * @returns {SpanContext} The updated span context.
     */
    public evaluateEvent(name: string, evaluator: string, data: Record<string, NodeInput>, {
        timestamp
    }: SpanEvaluateEventProps = {}): SpanContext {
        
        const event = {
            name,
            evaluator,
            data,
            timestamp: timestamp ?? new Date(),
            env: this.collector.getEnv(),
        } as EvaluateEvent;

        this.inerSpan.evaluateEvents.push(event);
        return this;
    }

    private getParent(): ObservationContext {
        return this.parent!;
    }

    private innerUpdate(
        input?: any | null,
        output?: any | null,
        metadata?: Record<string, any> | null,
        attributes?: Record<string, any>,
        evaluateEvents?: EvaluateEvent[],
        override?: boolean,
        finalize?: boolean,
    ): SpanContext {
        const newMetadata = override ? metadata : { ...this.observation.metadata, ...(metadata ?? {}) };
        const newAttributes = override ? attributes : { ...this.inerSpan.attributes, ...(attributes ?? {}) };
        const newEvaluateEvents = override ? evaluateEvents : [...this.inerSpan.evaluateEvents, ...(evaluateEvents ?? [])];
        (newEvaluateEvents ?? []).forEach((event) => {
            event.env = {...(event.env ?? {}), ...this.collector.getEnv()};
        });

        this.inerSpan.input = input || this.inerSpan.input;
        this.inerSpan.output = output || this.inerSpan.output;
        this.inerSpan.metadata = newMetadata ?? null;
        this.inerSpan.attributes = newAttributes ?? {};
        this.inerSpan.evaluateEvents = newEvaluateEvents ?? [];
        if (finalize) {
            this.inerSpan.endTime = new Date();
            this.collector.addTask(this.inerSpan);
        }
        return this;
    }
}

interface UpdateTraceProps {
    success?: boolean;
    userId?: string | null;
    sessionId?: string | null;
    release?: string;
    metadata?: Record<string, any> | null;
};

export class TraceContext extends ObservationContext {
    private trace: Trace;

    constructor(trace: Trace, parent: ObservationContext | null) {
        super(trace, parent);
        this.trace = trace;
        this.collector.addTask(this.trace);
    }

    public update({
        success,
        userId,
        sessionId,
        release,
        metadata
    }: UpdateTraceProps = {}): TraceContext {
        const newMetadata = metadata ? { ...this.observation.metadata, ...metadata } : this.observation.metadata;
        this.trace.success = success ?? this.trace.success;
        this.trace.userId = userId ?? this.trace.userId;
        this.trace.sessionId = sessionId ?? this.trace.sessionId;
        this.trace.release = release ?? this.trace.release;
        this.trace.metadata = newMetadata ?? null;

        this.collector.addTask(this.trace);

        return this;
    }
}

interface TraceProps {
    userId?: string | null;
    sessionId?: string | null;
    release?: string;
    metadata?: Record<string, any> | null;
};

export const trace = ({
    userId,
    sessionId,
    release,
    metadata,
}: TraceProps = {}): TraceContext => {
    const trace = {
        id: newUUID(),
        version: CURRENT_TRACING_VERSION,
        success: true,
        startTime: new Date(),
        endTime: null,
        userId: userId ?? null,
        sessionId: sessionId ?? newUUID(),
        release: release ?? "v1",
        metadata: metadata ?? null,
    } as Trace;

    return new TraceContext(trace, null);
}


/**
 * Initializes the SDK with the provided project API key and environment variables.
 * 
 * @param options - The options for initialization.
 * @param options.projectApiKey - The project API key. Needed to authenticate with the Laminar API.
 * @param options.env - The environment variables as a key-value pair. Passed to Laminar to be used in the evaluation.
 */
export const initialize = ({
    projectApiKey, env
} : {
    projectApiKey?: string,
    env?: Record<string, string>
}) => {
    const collector = CollectorSingleton.getInstance();
    collector.setProjectApiKey(projectApiKey);
    collector.setEnv(env ?? {});
}
