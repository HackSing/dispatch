/**
 * Host 半共享常量。ROUTE_PREFIX 是 dsh webServer 上的唯一挂载点,
 * client 半的 api-bridge 与本模块必须同源(经打包注入,不手抄)。
 *
 * @module dsh-dispatch/host/constants
 */

export const PACKAGE_NAME = '@aiwaretop/dsh-dispatch';
export const PLUGIN_ID = 'dispatch';
export const ROUTE_PREFIX = '/api/dispatch';
export const EVENT_STREAM_PATH = `${ROUTE_PREFIX}/events`;
export const INVOKE_PATH_PREFIX = `${ROUTE_PREFIX}/invoke/`;

/** 请求体上限:所有合法 invoke 载荷都是一个小对象(任务文本等) */
export const MAX_BODY_BYTES = 65536;

/** SSE 心跳间隔:防中间层闲置断连 */
export const SSE_PING_MS = 25_000;
