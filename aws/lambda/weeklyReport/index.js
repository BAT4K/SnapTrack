const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({ region: 'us-east-1' });
const ses = new SESClient({ region: 'us-east-1' });

exports.handler = async (event) => {
    try {
        const toEmail = process.env.TO_EMAIL;
        const fromEmail = process.env.FROM_EMAIL;
        
        if (!toEmail || !fromEmail) {
            throw new Error('TO_EMAIL and FROM_EMAIL must be set in environment variables');
        }

        // Calculate date 7 days ago
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const cutoffDate = sevenDaysAgo.toISOString();

        // Scan DynamoDB for last 7 days
        const scanParams = {
            TableName: 'SnapTrackMeals',
            FilterExpression: 'processedAt >= :cutoffDate',
            ExpressionAttributeValues: {
                ':cutoffDate': { S: cutoffDate }
            }
        };

        const { Items } = await dynamo.send(new ScanCommand(scanParams));
        
        let totalCalories = 0;
        let totalProtein = 0;
        let totalCarbs = 0;
        let totalFats = 0;

        Items.forEach(item => {
            const meal = unmarshall(item);
            totalCalories += (meal.totalCalories || 0);
            if (meal.macros) {
                totalProtein += (meal.macros.protein || 0);
                totalCarbs += (meal.macros.carbs || 0);
                totalFats += (meal.macros.fats || 0);
            }
        });

        const numDays = 7;
        const dailyAvgCalories = Math.round(totalCalories / numDays);
        const dailyAvgProtein = Math.round(totalProtein / numDays);
        const dailyAvgCarbs = Math.round(totalCarbs / numDays);
        const dailyAvgFats = Math.round(totalFats / numDays);

        const htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=JetBrains+Mono:wght@400;700&display=swap');
                body {
                    background-color: #0a0a0a;
                    color: #f0f0f0;
                    font-family: 'JetBrains Mono', monospace, Arial, sans-serif;
                    margin: 0;
                    padding: 0;
                    background-image: radial-gradient(#2a2a2a 1px, transparent 1px);
                    background-size: 24px 24px;
                }
                .container {
                    max-width: 600px;
                    margin: 40px auto;
                    background: #141414;
                    border: 1px solid #2a2a2a;
                    padding: 32px;
                }
                .header {
                    border-bottom: 2px solid #2a2a2a;
                    padding-bottom: 16px;
                    margin-bottom: 32px;
                }
                .system-status {
                    color: #FF5F1F;
                    font-size: 12px;
                    font-weight: bold;
                    letter-spacing: 2px;
                    margin-bottom: 8px;
                    text-transform: uppercase;
                }
                .title {
                    font-family: 'Bebas Neue', Impact, sans-serif;
                    font-size: 48px;
                    color: #ffffff;
                    margin: 0;
                    line-height: 1;
                    letter-spacing: 2px;
                }
                .title-accent {
                    color: #FF5F1F;
                }
                .subtitle {
                    color: #888888;
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    margin-top: 8px;
                }
                .stats-grid {
                    width: 100%;
                    border-collapse: separate;
                    border-spacing: 16px 0;
                    margin: 0 -16px;
                }
                .stat-box {
                    background: #0a0a0a;
                    border: 1px solid #2a2a2a;
                    padding: 24px;
                    text-align: center;
                    width: 50%;
                }
                .stat-label {
                    color: #888888;
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    margin-bottom: 8px;
                }
                .stat-value {
                    font-family: 'Bebas Neue', Impact, sans-serif;
                    font-size: 42px;
                    color: #ffffff;
                    margin: 0;
                }
                .stat-unit {
                    color: #FF5F1F;
                    font-size: 14px;
                    font-family: 'JetBrains Mono', monospace;
                }
                .macro-section {
                    margin-top: 32px;
                    border-top: 1px solid #2a2a2a;
                    padding-top: 32px;
                }
                .macro-title {
                    color: #888888;
                    font-size: 12px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    margin-bottom: 24px;
                    text-align: center;
                }
                .macro-grid {
                    width: 100%;
                }
                .macro-item {
                    text-align: center;
                    width: 33.33%;
                }
                .macro-label {
                    color: #888888;
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    margin-bottom: 4px;
                }
                .macro-val {
                    font-family: 'Bebas Neue', Impact, sans-serif;
                    font-size: 28px;
                    color: #ffffff;
                }
                .macro-unit {
                    font-size: 12px;
                    color: #888888;
                }
                .footer {
                    margin-top: 40px;
                    text-align: center;
                    border-top: 1px solid #2a2a2a;
                    padding-top: 16px;
                    color: #555555;
                    font-size: 10px;
                    letter-spacing: 1px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="system-status">● WEEKLY DIAGNOSTIC REPORT</div>
                    <h1 class="title">SnapTrack<span class="title-accent">.AI</span></h1>
                    <div class="subtitle">// SERVERLESS CALORIE INTELLIGENCE</div>
                </div>

                <table class="stats-grid">
                    <tr>
                        <td class="stat-box">
                            <div class="stat-label">Total Output</div>
                            <div class="stat-value">${totalCalories} <span class="stat-unit">KCAL</span></div>
                        </td>
                        <td class="stat-box">
                            <div class="stat-label">Daily Average</div>
                            <div class="stat-value">${dailyAvgCalories} <span class="stat-unit">KCAL</span></div>
                        </td>
                    </tr>
                </table>

                <div class="macro-section">
                    <div class="macro-title">Macro Distribution (Weekly Totals)</div>
                    <table class="macro-grid">
                        <tr>
                            <td class="macro-item">
                                <div class="macro-label">PRO</div>
                                <div class="macro-val">${totalProtein}<span class="macro-unit">g</span></div>
                            </td>
                            <td class="macro-item">
                                <div class="macro-label">CRB</div>
                                <div class="macro-val">${totalCarbs}<span class="macro-unit">g</span></div>
                            </td>
                            <td class="macro-item">
                                <div class="macro-label">FAT</div>
                                <div class="macro-val">${totalFats}<span class="macro-unit">g</span></div>
                            </td>
                        </tr>
                    </table>
                </div>

                <div class="macro-section">
                    <div class="macro-title">Daily Averages</div>
                    <table class="macro-grid">
                        <tr>
                            <td class="macro-item">
                                <div class="macro-label">PRO / DAY</div>
                                <div class="macro-val">${dailyAvgProtein}<span class="macro-unit">g</span></div>
                            </td>
                            <td class="macro-item">
                                <div class="macro-label">CRB / DAY</div>
                                <div class="macro-val">${dailyAvgCarbs}<span class="macro-unit">g</span></div>
                            </td>
                            <td class="macro-item">
                                <div class="macro-label">FAT / DAY</div>
                                <div class="macro-val">${dailyAvgFats}<span class="macro-unit">g</span></div>
                            </td>
                        </tr>
                    </table>
                </div>

                <div class="footer">
                    END OF TRANSMISSION // GENERATED AUTOMATICALLY
                </div>
            </div>
        </body>
        </html>
        `;

        const emailParams = {
            Source: fromEmail,
            Destination: {
                ToAddresses: [toEmail]
            },
            Message: {
                Subject: {
                    Data: 'SnapTrack.AI // Weekly Caloric Intelligence Report'
                },
                Body: {
                    Html: {
                        Data: htmlBody
                    }
                }
            }
        };

        await ses.send(new SendEmailCommand(emailParams));

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Weekly report sent successfully' })
        };

    } catch (error) {
        console.error('Error generating weekly report:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Internal Server Error' })
        };
    }
};
