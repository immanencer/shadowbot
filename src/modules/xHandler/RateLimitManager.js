// This file is no longer needed if using the official plugin.
// ...existing code commented out or removed...
// export class RateLimitManager {
//     constructor() {
//         this.limits = {
//             tweets: { remaining: null, reset: null },
//             mentions: { remaining: null, reset: null },
//             media: { remaining: null, reset: null }
//         };
//         this.minBuffer = 5; // Keep some requests in reserve
//     }

//     updateLimits(endpoint, headers) {
//         if (headers && headers['x-rate-limit-remaining'] && headers['x-rate-limit-reset']) {
//             this.limits[endpoint] = {
//                 remaining: parseInt(headers['x-rate-limit-remaining'], 10),
//                 reset: parseInt(headers['x-rate-limit-reset'], 10) * 1000 // Convert to milliseconds
//             };
//             console.log(`Rate limits for ${endpoint}: ${this.limits[endpoint].remaining} remaining, resets at ${new Date(this.limits[endpoint].reset).toISOString()}`);
//         } else {
//             this.limits[endpoint] = {
//                 remaining: 1,    // Lower default
//                 reset: Date.now() + 30 * 1000 // Increase wait time
//             };
//             console.warn(`Rate limit headers missing for ${endpoint}`);
//         }
//     }

//     async shouldThrottle(endpoint) {
//         const limit = this.limits[endpoint];
//         if (!limit || limit.remaining === null || limit.remaining <= this.minBuffer) {
//             const now = Date.now();
//             if (limit && now < limit.reset) {
//                 let waitTime = limit.reset - now;
//                 const maxWaitTime = 2147483647;
//                 if (waitTime > maxWaitTime) {
//                     console.warn(`Wait time (${waitTime}) exceeds 32-bit limit. Clamping to ${maxWaitTime}`);
//                     waitTime = maxWaitTime;
//                 }
//                 console.log(`Rate limit near for ${endpoint}, waiting ${waitTime}ms`);
//                 await new Promise(resolve => setTimeout(resolve, waitTime));
//                 return true;
//             }
//         }
//         return false;
//     }

//     getOptimalInterval(endpoint) {
//         const limit = this.limits[endpoint];
//         if (!limit || limit.remaining === null || !limit.reset) return 60000; // Default 1 minute
        
//         const timeToReset = limit.reset - Date.now();
//         return Math.max(timeToReset / (limit.remaining - this.minBuffer), 1000);
//     }

//     async executeWithRateLimit(endpoint, apiCall, attempt = 0) {
//         await this.shouldThrottle(endpoint);
//         try {
//             const response = await apiCall();
//             if (response.headers) { this.updateLimits(endpoint, response.headers); }
//             return response;
//         } catch (error) {
//             if (error.response?.status === 429) {
//                 if (attempt < 3) {
//                     console.warn(`Rate limit exceeded for ${endpoint}, retry attempt ${attempt + 1}`);
//                     await this.shouldThrottle(endpoint);
//                     return this.executeWithRateLimit(endpoint, apiCall, attempt + 1);
//                 } else {
//                     console.error('Max retry attempts reached for 429 errors');
//                     throw error;
//                 }
//             }
//             throw error;
//         }
//     }
// }