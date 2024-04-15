import { createHandler, TOKEN_HEADER_KEY } from 'graphql-sse';
let eventStreamRoute = '', handler = () => {
    throw new Error('graphql-sse handler not initialised');
}, parse = () => {
    throw new Error('graphql parse not initialised');
}, specifiedRules, validate = () => {
    throw new Error('graphql validate not initialised');
}, execute = () => {
    throw new Error('graphql execute not initialised');
}, subscribe = () => {
    throw new Error('graphql subscribe not initialised');
}, pluginHook = () => {
    throw new Error('PostGraphile pluginHook not initialised');
};
// some callbacks of graphql-sse dont supply the response (like onNext)
const resForReq = new Map();
const GraphQLSSEPlugin = {
    init(_, { graphql }) {
        // copied from https://github.com/graphile/postgraphile/blob/55bff41460b113481c8161ef8f178f5af0a17df3/isTurbo.js
        const major = parseInt(process.version.replace(/\..*$/, ''), 10);
        if (major < 12) {
            throw new Error('graphql-sse requres Node >=12');
        }
        parse = graphql.parse;
        specifiedRules = graphql.specifiedRules;
        validate = graphql.validate;
        execute = graphql.execute;
        subscribe = graphql.subscribe;
        return _;
    },
    pluginHook(postgraphilePluginHook) {
        return (pluginHook = postgraphilePluginHook);
    },
    'postgraphile:middleware'(middleware) {
        const { options, getGraphQLSchema, withPostGraphileContextFromReqRes, handleErrors, } = middleware;
        // intentionally not taking from options because middleware will guarantee there's a route
        eventStreamRoute = middleware.eventStreamRoute;
        if (!eventStreamRoute) {
            throw new Error('graphql-sse cannot start because of eventStreamRoute is missing');
        }
        const staticValidationRules = pluginHook('postgraphile:validationRules:static', specifiedRules, {
            options,
        });
        // some values necessary for dynamic validation are not available in `validate` callback
        const dynamicValidationRulesForDocument = new Map();
        // @ts-ignore
        handler = createHandler({
            execute,
            subscribe,
            validate(schema, document) {
                try {
                    return validate(schema, document, [
                        ...staticValidationRules,
                        ...(dynamicValidationRulesForDocument.get(document) || []),
                    ]);
                }
                finally {
                    dynamicValidationRulesForDocument.delete(document);
                }
            },
            async onSubscribe(req, params) {
                const context = await withPostGraphileContextFromReqRes(req.raw, req.context, { singleStatement: true }, (context) => context);
                const args = {
                    schema: await getGraphQLSchema(),
                    contextValue: context,
                    operationName: params.operationName,
                    document: typeof params.query === 'string'
                        ? parse(params.query)
                        : params.query,
                    variableValues: params.variables,
                };
                // You are strongly encouraged to use
                // `postgraphile:validationRules:static` if possible - you should
                // only use this one if you need access to variables.
                const dynamicValidationRules = pluginHook('postgraphile:validationRules', [], {
                    options,
                    req,
                    res: req.context,
                    variables: args.variableValues,
                    operationName: args.operationName,
                });
                if (dynamicValidationRules.length) {
                    dynamicValidationRulesForDocument.set(args.document, dynamicValidationRules);
                }
                return args;
            },
            async onNext(_ctx, req, result) {
                if (result.errors) {
                    result.errors = handleErrors(result.errors, req.raw, resForReq.get(req.raw));
                    return result;
                }
            },
        });
        return middleware;
    },
    // TODO: cannot use "postgraphile:http:eventStreamRouteHandler" because watchPg has to be true (https://github.com/graphile/postgraphile/blob/55bff41460b113481c8161ef8f178f5af0a17df3/src/postgraphile/http/createPostGraphileHttpRequestHandler.ts#L548-L553)
    'postgraphile:http:handler'(req, ctx) {
        // TODO: context typings for the hook are incorrect (https://github.com/graphile/postgraphile/blob/55bff41460b113481c8161ef8f178f5af0a17df3/src/postgraphile/http/createPostGraphileHttpRequestHandler.ts#L528-L532)
        const options = ctx.options;
        const res = ctx.res;
        const next = ctx.next;
        // inform clients about where they can use the event-stream
        res.setHeader('X-GraphQL-Event-Stream', eventStreamRoute);
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        if (url.pathname !== eventStreamRoute) {
            return req;
        }
        // receiving a GET request without query params is probably PostGraphile emitting schema changes
        if (req.method === 'GET' &&
            !req.headers[TOKEN_HEADER_KEY] &&
            !url.searchParams.has('query')) {
            if (req.headers.accept !== 'text/event-stream') {
                // this conditional is intentionally nested here because "single connection mode" in GraphQL over SSE accepts non-event stream requests
                // for more information, please read: https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md#single-connection-mode
                res.statusCode = 405;
                res.end();
                next();
                // TODO: wrong typings for the hook. returning a nullish indicates that the hook is taking over
                return null;
            }
            return req;
        }
        if (options.enableCors) {
            addCORSHeaders(res);
        }
        // Just a CORS preflight check
        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            next();
            // TODO: wrong typings for the hook. returning a nullish indicates that the hook is taking over
            return null;
        }
        resForReq.set(req, res);
        handler({
            raw: req,
            context: res,
        })
            .then(() => {
            next();
        })
            .catch((err) => {
            // handler should throw only on fatal errors
            console.error(err);
            if (!res.headersSent) {
                res.writeHead(500, 'Internal Server Error').end();
            }
            next(err);
        })
            .finally(() => {
            resForReq.delete(req);
        });
        // TODO: wrong typings for the hook. returning a nullish indicates that the hook is taking over
        return null;
    },
};
/**
 * We require the Node response (instead of PostGraphileResponse) because graphql-sse
 * will append more headers down the read and flush them on its own.
 *
 * Mostly copied from https://github.com/graphile/postgraphile/blob/55bff41460b113481c8161ef8f178f5af0a17df3/src/postgraphile/http/createPostGraphileHttpRequestHandler.ts#L1145-L1181
 */
function addCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // For "single connection mode" GraphQL over SSE
    //   - PUT creates a event stream reservation
    //   - DELETE stops an active subscription in a stream
    res.setHeader('Access-Control-Allow-Methods', 'HEAD, GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', [
        'Origin',
        'X-Requested-With',
        // Used by `express-graphql` to determine whether to expose the GraphiQL
        // interface (`text/html`) or not.
        'Accept',
        // Used by PostGraphile for auth purposes.
        'Authorization',
        // Used by GraphQL Playground and other Apollo-enabled servers
        'X-Apollo-Tracing',
        // The `Content-*` headers are used when making requests with a body,
        // like in a POST request.
        'Content-Type',
        'Content-Length',
        // For our 'Explain' feature
        'X-PostGraphile-Explain',
        // For "single connection mode" GraphQL over SSE
        TOKEN_HEADER_KEY,
    ].join(', '));
    res.setHeader('Access-Control-Expose-Headers', ['X-GraphQL-Event-Stream'].join(', '));
}
GraphQLSSEPlugin;
