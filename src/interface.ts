import { CURRENT_TRACING_VERSION } from "./constants";
import { Collector, CollectorSingleton } from "./tracing";
import { EvaluateEvent, Span, Trace, Event } from "./types";

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
        input?: any | null,
        metadata?: Record<string, any> | null,
        attributes?: Record<string, any>,
        spanType?: 'DEFAULT' | 'LLM'
    ): SpanContext {
        const parent = this as ObservationContext;
        const parentSpanId = 
            parent instanceof SpanContext ? parent.observation.id : null;
        
        const traceId = parent instanceof TraceContext
            ? parent.observation.id
            : (parent.observation as  Span).traceId;

        const span = {
            version: CURRENT_TRACING_VERSION,
            spanType: spanType ?? 'DEFAULT',
            id: crypto.randomUUID(),
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

export class SpanContext extends ObservationContext {
    private inerSpan: Span;
    
    constructor(span: Span, parent: ObservationContext) {
        super(span, parent);
        this.inerSpan = span;
    }

    public end(
        input?: any | null,
        output?: any | null,
        metadata?: Record<string, any> | null,
        attributes?: Record<string, any>,
        evaluateEvents?: EvaluateEvent[],
        override?: boolean
    ): SpanContext {
        if (this.children && Object.keys(this.children).length > 0) {
            console.warn(`Ending span ${this.observation.id}, but it has children that have not been finalized.` +
                ` Children: ${Object.values(this.children).map((child) => child.inerSpan.name)}`);
            }

        
        delete this.getParent().children[this.inerSpan.id];
        this.innerUpdate(input, output, metadata, attributes, evaluateEvents, override, true);
        
        return this;
    }

    public update(
        input?: any | null,
        output?: any | null,
        metadata?: Record<string, any> | null,
        attributes?: Record<string, any>,
        evaluateEvents?: EvaluateEvent[],
        override?: boolean
    ): SpanContext {
        return this.innerUpdate(input, output, metadata, attributes, evaluateEvents, override, false);
    }

    public event(templateName: string, value?: string | number | boolean, timestamp?: Date): SpanContext {
        const event = {
            id: crypto.randomUUID(),
            templateName,
            timestamp: timestamp ?? new Date(),
            spanId: this.inerSpan.id,
            value: value ?? null,
        } as Event;

        this.inerSpan.events.push(event);
        return this;
    }

    public evalueateEvent(templateName: string, data: string): SpanContext {
        const event = {
            name: templateName,
            data,
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

export class TraceContext extends ObservationContext {
    private trace: Trace;

    constructor(trace: Trace, parent: ObservationContext | null) {
        super(trace, parent);
        this.trace = trace;
        this.collector.addTask(this.trace);
    }

    public update(
        success?: boolean,
        userId?: string | null,
        sessionId?: string | null,
        release?: string,
        metadata?: Record<string, any> | null
    ): TraceContext {
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

export const trace = () => {
    const trace = {
        id: crypto.randomUUID(),
        version: CURRENT_TRACING_VERSION,
        success: true,
        startTime: new Date(),
        endTime: null,
        userId: null,
        sessionId: null,
        release: "v1",
        metadata: null,
    } as Trace;

    return new TraceContext(trace, null);
}
