const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

class UAJYScraper {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({ jar: this.jar, withCredentials: true }));
    this.sesskey = null;
  }

  async login() {
    console.log(`[university] Logging in user: ${this.username}`);
    const res = await this.client.get('https://kuliah.uajy.ac.id/login/index.php');
    const $ = cheerio.load(res.data);
    const logintoken = $('input[name="logintoken"]').val();
    
    await this.client.post('https://kuliah.uajy.ac.id/login/index.php', new URLSearchParams({
      logintoken, username: this.username, password: this.password
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    
    const dashboard = await this.client.get('https://kuliah.uajy.ac.id/my/');
    if (dashboard.data.includes('login/index.php')) {
        throw new Error('Login failed: Invalid credentials or token');
    }
    
    this.sesskey = dashboard.data.match(/sesskey":"([^"]+)"/)?.[1];
    console.log(`[university] Login successful for ${this.username}, sesskey found: ${!!this.sesskey}`);
  }

  async getCourses() {
    const res = await this.client.get('https://kuliah.uajy.ac.id/my/');
    if (res.data.includes('login/index.php') || (res.request.res && res.request.res.responseUrl && res.request.res.responseUrl.includes('login/index.php'))) {
        throw new Error('Not logged in');
    }
    const $ = cheerio.load(res.data);
    const courses = [];
    $('a[href*="course/view.php"]').each((i, el) => {
        const name = $(el).text().trim();
        const url = $(el).attr('href');
        const idMatch = url.match(/id=(\d+)/);
        const id = idMatch ? idMatch[1] : null;
        if (id && name && name.length > 3) courses.push({ name, id });
    });
    // Deduplicate
    return [...new Map(courses.map(item => [item.id, item])).values()];
  }

  async getTasks() {
    if (!this.sesskey) await this.login();
    this.getCourses();
    const url = `https://kuliah.uajy.ac.id/lib/ajax/service.php?sesskey=${this.sesskey}&info=core_calendar_get_action_events_by_timesort`;
    const res = await this.client.post(url, [{
      index: 0, methodname: 'core_calendar_get_action_events_by_timesort', 
      args: { limitnum: 20, timesortfrom: 0, limittononsuspendedevents: true }
    }]);
    
    if (!res.data || !res.data[0] || !res.data[0].data) return [];
    
    return res.data[0].data.events.map(e => ({ 
        name: e.name, 
        due: e.formattedtime, 
        url: e.url, 
        courseId: e.courseid,
        courseName: e.course?.fullname
    }));
  }

  async getCourseContent(courseId) {
    const res = await this.client.get(`https://kuliah.uajy.ac.id/course/view.php?id=${courseId}`);
    if (res.data.includes('login/index.php')) {
        throw new Error('Not logged in');
    }
    const $ = cheerio.load(res.data);
    const topics = [];
    $('.section.main').each((i, el) => {
        const section = $(el);
        const name = section.find('.sectionname').text().trim();
        const items = [];
        section.find('li.activity').each((j, act) => {
            const item = $(act);
            const id = item.attr('id');
            const instanceName = item.find('.instancename').text().replace('Available', '').trim();
            const url = item.find('a').attr('href');
            if(instanceName) items.push({ name: instanceName, id, url });
        });
        if (name || items.length > 0) topics.push({ name, items });
    });
    return topics;
  }
}

module.exports = UAJYScraper;
